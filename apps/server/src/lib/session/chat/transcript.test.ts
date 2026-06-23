import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEntry, parseTranscriptLine, locateTranscript, launchFlag, TranscriptTail } from './transcript';

describe('classifyEntry（按 content-block 判定角色，而非 message.role）', () => {
  it('人类文本：字符串 content → human', () => {
    expect(classifyEntry({ type: 'user', message: { role: 'user', content: '你好' } })).toBe('human');
  });
  it('人类文本：text 块 → human', () => {
    expect(classifyEntry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })).toBe('human');
  });
  it('工具结果：content 数组含 tool_result → tool_result', () => {
    expect(
      classifyEntry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'o' }] } }),
    ).toBe('tool_result');
  });
  it('工具结果：顶层 toolUseResult 也判 tool_result', () => {
    expect(classifyEntry({ type: 'user', toolUseResult: 'x', message: { role: 'user', content: [] } })).toBe('tool_result');
  });
  it('噪声：isMeta（命令包装）→ noise', () => {
    expect(
      classifyEntry({ type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/effort</command-name>' } }),
    ).toBe('noise');
  });
  it('噪声：isCompactSummary → noise', () => {
    expect(classifyEntry({ type: 'user', isCompactSummary: true, message: { role: 'user', content: '…continued…' } })).toBe('noise');
  });
  it('噪声：isSidechain（子代理）→ noise', () => {
    expect(classifyEntry({ type: 'user', isSidechain: true, message: { role: 'user', content: 'task desc' } })).toBe('noise');
  });
  it('assistant → assistant', () => {
    expect(classifyEntry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })).toBe('assistant');
  });
  it('非 user|assistant 类型 → noise', () => {
    expect(classifyEntry({ type: 'system' })).toBe('noise');
    expect(classifyEntry({ type: 'attachment' })).toBe('noise');
  });
});

describe('parseTranscriptLine', () => {
  it('user 文本', () => {
    const o = { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
    expect(parseTranscriptLine(JSON.stringify(o))).toMatchObject({
      uuid: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
    });
  });

  it('assistant text + tool_use', () => {
    const o = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'doing' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    const m = parseTranscriptLine(JSON.stringify(o))!;
    expect(m.role).toBe('assistant');
    expect(m.blocks).toHaveLength(2);
    expect(m.blocks[1]).toMatchObject({ type: 'tool_use', name: 'Bash', id: 't1' });
  });

  it('thinking 块取 thinking 字段', () => {
    const o = { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } };
    expect(parseTranscriptLine(JSON.stringify(o))!.blocks[0]).toEqual({ type: 'thinking', text: 'hmm' });
  });

  it('tool_result（content 数组拍平为字符串）', () => {
    const o = {
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }] }] },
    };
    expect(parseTranscriptLine(JSON.stringify(o))!.blocks[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 't1',
      content: 'out',
    });
  });

  it('忽略 meta 行 / 空内容 / 坏 JSON', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'attachment' }))).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }))).toBeNull();
    expect(parseTranscriptLine('not json')).toBeNull();
  });

  it('净化：isMeta 命令包装不渲染', () => {
    const o = { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: '<command-name>/effort</command-name>' } };
    expect(parseTranscriptLine(JSON.stringify(o))).toBeNull();
  });

  it('净化：isSidechain（子代理）不渲染', () => {
    const o = { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } };
    expect(parseTranscriptLine(JSON.stringify(o))).toBeNull();
  });

  it('tool_result-only 仍渲染为 role:user + tool_result 块（供前端按 id 配对）', () => {
    const o = { type: 'user', uuid: 'tr1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] } };
    expect(parseTranscriptLine(JSON.stringify(o))).toMatchObject({ role: 'user', blocks: [{ type: 'tool_result', toolUseId: 't1' }] });
  });
});

describe('locateTranscript', () => {
  it('按 sessionId 在 projects 子目录中定位', () => {
    const base = mkdtempSync(join(tmpdir(), 'rcc-proj-'));
    mkdirSync(join(base, '-some-proj'));
    const target = join(base, '-some-proj', 'abc-123.jsonl');
    writeFileSync(target, '');
    expect(locateTranscript('abc-123', base)).toBe(target);
    expect(locateTranscript('missing', base)).toBeNull();
  });
});

describe('launchFlag', () => {
  it('有 transcript → --resume，无 → --session-id', () => {
    const base = mkdtempSync(join(tmpdir(), 'rcc-flag-'));
    mkdirSync(join(base, '-p'));
    writeFileSync(join(base, '-p', 'exists-id.jsonl'), '');
    expect(launchFlag('exists-id', base)).toBe('--resume exists-id');
    expect(launchFlag('new-id', base)).toBe('--session-id new-id');
  });
});

describe('TranscriptTail.activeChain', () => {
  const newFile = () => join(mkdtempSync(join(tmpdir(), 'rcc-tail-')), 's.jsonl');
  const userLine = (uuid: string, parentUuid: string | null, text: string) =>
    JSON.stringify({ type: 'user', uuid, parentUuid, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  const asstLine = (uuid: string, parentUuid: string | null, text: string) =>
    JSON.stringify({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
  const sysLine = (uuid: string, parentUuid: string | null) =>
    JSON.stringify({ type: 'system', uuid, parentUuid, content: 'x' }) + '\n';
  const attLine = (uuid: string, parentUuid: string | null) =>
    JSON.stringify({ type: 'attachment', uuid, parentUuid }) + '\n';

  it('线性：沿 parentUuid 给出正序，append 后增量', () => {
    const file = newFile();
    writeFileSync(file, userLine('u1', null, 'a') + asstLine('a1', 'u1', 'b'));
    const tail = new TranscriptTail(() => file);
    expect(tail.activeChain().map((m) => m.uuid)).toEqual(['u1', 'a1']);
    appendFileSync(file, userLine('u2', 'a1', 'c'));
    expect(tail.activeChain().map((m) => m.uuid)).toEqual(['u1', 'a1', 'u2']);
  });

  it('分叉（rewind）：只取活动分支，游离分支不出现', () => {
    const file = newFile();
    // att2(root) → att3 → u_create → a_create → sys1   （老分支，被 rewind 掉）
    //                    └→ u_branch → a_branch → sys2  （新分支，parent 指回 att3）
    writeFileSync(
      file,
      attLine('att2', null) +
        attLine('att3', 'att2') +
        userLine('u_create', 'att3', 'Create a file') +
        asstLine('a_create', 'u_create', 'I will create') +
        sysLine('sys1', 'a_create') +
        userLine('u_branch', 'att3', 'branch-test') +
        asstLine('a_branch', 'u_branch', 'branch-test') +
        sysLine('sys2', 'a_branch'),
    );
    const tail = new TranscriptTail(() => file);
    const chain = tail.activeChain();
    expect(chain.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(chain)).toContain('branch-test');
    expect(JSON.stringify(chain)).not.toContain('Create a file');
  });

  it('重连（reset 后重读）仍给活动分支', () => {
    const file = newFile();
    writeFileSync(file, userLine('u1', null, 'a') + asstLine('a1', 'u1', 'b'));
    const tail = new TranscriptTail(() => file);
    tail.activeChain();
    tail.reset();
    expect(tail.activeChain().map((m) => m.uuid)).toEqual(['u1', 'a1']);
  });

  it('子代理 sidechain 不污染主线（即便 sidechain 为最后写入）', () => {
    const file = newFile();
    const sideUser = (uuid: string) =>
      JSON.stringify({ type: 'user', uuid, parentUuid: null, isSidechain: true, message: { role: 'user', content: 'task desc' } }) + '\n';
    const sideAsst = (uuid: string, p: string) =>
      JSON.stringify({ type: 'assistant', uuid, parentUuid: p, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub work' }] } }) + '\n';
    // 主线 u1→a1 完成后,子代理 sidechain(sd1→sd2) 最后写入
    writeFileSync(file, userLine('u1', null, 'main q') + asstLine('a1', 'u1', 'main a') + sideUser('sd1') + sideAsst('sd2', 'sd1'));
    const tail = new TranscriptTail(() => file);
    const chain = tail.activeChain();
    expect(chain.map((m) => m.uuid)).toEqual(['u1', 'a1']);
    expect(JSON.stringify(chain)).not.toContain('sub work');
    expect(JSON.stringify(chain)).not.toContain('task desc');
  });

  it('文件不存在时返回空', () => {
    const tail = new TranscriptTail(() => null);
    expect(tail.activeChain()).toEqual([]);
  });
});

describe('TranscriptTail.lastAssistantUsage', () => {
  const newFile = () => join(mkdtempSync(join(tmpdir(), 'rcc-usage-')), 's.jsonl');
  const userLine = (uuid: string, parentUuid: string | null, text: string) =>
    JSON.stringify({ type: 'user', uuid, parentUuid, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  const asstUsage = (uuid: string, parentUuid: string | null, usage: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage } }) + '\n';

  it('取最后写入的主线 assistant.usage', () => {
    const file = newFile();
    writeFileSync(
      file,
      userLine('u1', null, 'a') +
        asstUsage('a1', 'u1', { input_tokens: 100, cache_read_input_tokens: 200 }) +
        userLine('u2', 'a1', 'b') +
        asstUsage('a2', 'u2', { input_tokens: 500, cache_read_input_tokens: 1000 }),
    );
    const tail = new TranscriptTail(() => file);
    expect(tail.lastAssistantUsage()).toEqual({ input_tokens: 500, cache_read_input_tokens: 1000 });
  });

  it('无 assistant/无 usage → null', () => {
    const file = newFile();
    writeFileSync(file, userLine('u1', null, 'a'));
    const tail = new TranscriptTail(() => file);
    expect(tail.lastAssistantUsage()).toBeNull();
  });

  it('排除 sidechain 的 usage（只取主线）', () => {
    const file = newFile();
    const sideAsst = JSON.stringify({
      type: 'assistant', uuid: 'sd1', parentUuid: null, isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: 9999 } },
    }) + '\n';
    writeFileSync(file, userLine('u1', null, 'a') + asstUsage('a1', 'u1', { input_tokens: 42 }) + sideAsst);
    const tail = new TranscriptTail(() => file);
    expect(tail.lastAssistantUsage()).toEqual({ input_tokens: 42 });
  });
});

describe('TranscriptTail × 真实片段夹具（工具往返 + 噪声/侧链净化）', () => {
  const fixture = join(__dirname, '__fixtures__', 'transcript_tool_round.jsonl');
  it('一轮含工具:主线 = [人类, 助手(文本+工具), 工具结果, 助手(文本)],meta/sidechain 排除', () => {
    const tail = new TranscriptTail(() => fixture);
    const chain = tail.activeChain();
    expect(chain.map((m) => m.uuid)).toEqual(['u1', 'a2', 'r3', 'a5']);
    expect(chain.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(chain[1].blocks).toContainEqual({ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } });
    expect(chain[2].blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_ls' });
    const json = JSON.stringify(chain);
    expect(json).not.toContain('effort'); // 命令包装(isMeta)净化
    expect(json).not.toContain('subagent'); // 子代理 sidechain 净化
  });
});
