import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexTranscriptTail, parseCodexLine } from './codexTranscript';

describe('parseCodexLine', () => {
  it('用户消息(response_item message role=user, input_text)→ ChatMessage role=user', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我写代码' }] },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('user');
    expect(r?.blocks).toEqual([{ type: 'text', text: '帮我写代码' }]);
  });

  it('助手消息(response_item message role=assistant, output_text)→ ChatMessage role=assistant', () => {
    // 真实数据里 assistant 的 content 是 output_text(非 input_text);宽松 text 块匹配同时吃下两种。
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:01Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的我来帮你' }] },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('assistant');
    expect(r?.blocks).toEqual([{ type: 'text', text: '好的我来帮你' }]);
  });

  it('event_msg agent_message → null(避免与 response_item assistant 重复渲染)', () => {
    // 真实数据下同一段助手输出同时在 event_msg(agent_message)与 response_item(message role=assistant)
    // 出现 100% 重合;只认后者,避免聊天视图显示两遍。
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:01Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: '好的我开始' },
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('function_call(response_item)→ assistant 块 tool_use', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:02Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"command":"ls"}',
        call_id: 'call_1',
      },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('assistant');
    expect(r?.blocks[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'exec_command', input: { command: 'ls' } });
  });

  it('function_call arguments parse 失败 → 用原串作 input(不抛错)', () => {
    const line = JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: { type: 'function_call', name: 'tool_x', arguments: '{bad', call_id: 'call_bad' },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('assistant');
    expect(r?.blocks[0]).toMatchObject({ type: 'tool_use', id: 'call_bad', name: 'tool_x', input: '{bad' });
  });

  it('function_call_output(response_item)→ user 块 tool_result', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:03Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'a\nb\nc' },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('user');
    expect(r?.blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'call_1', content: 'a\nb\nc' });
  });

  it('reasoning(response_item, summary 有内容)→ assistant 块 thinking', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:04Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: '让我想想' }] },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('assistant');
    expect(r?.blocks[0]).toMatchObject({ type: 'thinking', text: '让我想想' });
  });

  it('reasoning summary 为空 → null(真实数据 summary 多为空,真内容在 encrypted_content)', () => {
    const line = JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [] },
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('response_item message role=developer / system → null(注入角色不渲染)', () => {
    const line = JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '注入指令' }] },
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('session_meta / turn_context / 其他 event_msg 子类 → null', () => {
    expect(parseCodexLine(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'turn_context', payload: {} }))).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }))).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }))).toBeNull();
  });

  it('坏 JSON / 空行 → null(不挂掉整个流)', () => {
    expect(parseCodexLine('{not json')).toBeNull();
    expect(parseCodexLine('')).toBeNull();
    expect(parseCodexLine('   ')).toBeNull();
  });
});

describe('CodexTranscriptTail', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `rcc-codex-tail-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('按时间戳顺序还原可渲染消息(只认 response_item 系列)', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: {} }),
      JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
      JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } }),
    ].join('\n') + '\n');
    const tail = new CodexTranscriptTail(() => file);
    const chain = tail.activeChain();
    expect(chain.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chain[0].blocks[0]).toMatchObject({ type: 'text', text: 'hi' });
    expect(chain[1].blocks[0]).toMatchObject({ type: 'text', text: 'hello' });
  });

  it('助手双源(event_msg agent_message + response_item assistant message)只渲染一次', () => {
    // 真实 codex 场景:同一段助手输出同时出现在两个事件里。本解析器只认 response_item,
    // 故 chain 里只应出现一条 assistant text(不重复)。
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }] } }),
      JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'agent_message', message: '回答' } }),
      JSON.stringify({ timestamp: 't3', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] } }),
    ].join('\n') + '\n');
    const tail = new CodexTranscriptTail(() => file);
    const chain = tail.activeChain();
    // 期望 2 条:user + assistant;不是 3 条(若双源都出会变成 user + assistant + assistant)
    expect(chain.length).toBe(2);
    expect(chain.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chain[1].blocks[0]).toMatchObject({ type: 'text', text: '回答' });
  });

  it('增量 ingest:append 新行只解析新内容', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] } }) + '\n');
    const tail = new CodexTranscriptTail(() => file);
    expect(tail.activeChain().length).toBe(1);
    fs.appendFileSync(file, JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] } }) + '\n');
    const chain = tail.activeChain();
    expect(chain.length).toBe(2);
    expect(chain[1].blocks[0]).toMatchObject({ type: 'text', text: 'b' });
  });

  it('getPath 返回 null 时 activeChain 返回空', () => {
    const tail = new CodexTranscriptTail(() => null);
    expect(tail.activeChain()).toEqual([]);
  });

  it('lastAssistantUsage 从 token_count.payload.info.last_token_usage 取(真实嵌套形状)', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      timestamp: 't1', type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 64720, cached_input_tokens: 50000, output_tokens: 256, reasoning_output_tokens: 0, total_tokens: 64976 },
          total_token_usage: { input_tokens: 200000, output_tokens: 1024, total_tokens: 201024 },
          model_context_window: 200000,
        },
      },
    }) + '\n');
    const tail = new CodexTranscriptTail(() => file);
    tail.activeChain();  // 触发 ingest
    const usage = tail.lastAssistantUsage?.();
    expect(usage).toMatchObject({ input_tokens: 64720, output_tokens: 256, total_tokens: 64976 });
  });

  it('lastAssistantUsage 在 last_token_usage 缺时退到 total_token_usage', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      timestamp: 't1', type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } } },
    }) + '\n');
    const tail = new CodexTranscriptTail(() => file);
    tail.activeChain();
    expect(tail.lastAssistantUsage?.()).toMatchObject({ input_tokens: 100, output_tokens: 50 });
  });

  it('reset 清掉偏移/消息/usage/skipped 计数', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] } }) + '\n');
    const tail = new CodexTranscriptTail(() => file);
    expect(tail.activeChain().length).toBe(1);
    tail.reset();
    expect(tail.activeChain().length).toBe(1);  // reset 后重读还是能拿到
  });

  it('skippedLineCount 计数 session_meta / turn_context 等"非消息非 usage"的行', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: {} }),
      JSON.stringify({ timestamp: 't1', type: 'turn_context', payload: {} }),
      JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
    ].join('\n') + '\n');
    const tail = new CodexTranscriptTail(() => file);
    tail.activeChain();
    // session_meta + turn_context = 2 条预期跳过;message 不计。
    expect(tail.skippedLineCount()).toBe(2);
  });
});
