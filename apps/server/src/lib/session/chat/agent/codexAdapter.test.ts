import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCodexAdapter } from './codexAdapter';

const adapter = makeCodexAdapter({
  serviceUser: os.userInfo().username,
  homeFor: (u: string) => (u === os.userInfo().username ? os.homedir() : `/home/${u}`),
});

function todayDir(home: string): string {
  const d = new Date();
  return path.join(
    home, '.codex', 'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
}

function writeRollout(home: string, sid: string, cwd: string, lines: string[] = [], ts = Date.now()): string {
  const dir = todayDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${ts}-${sid}.jsonl`);
  const meta = JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    type: 'session_meta',
    payload: { session_id: sid, cwd },
  });
  fs.writeFileSync(file, [meta, ...lines].join('\n') + '\n');
  fs.utimesSync(file, new Date(ts), new Date(ts));
  return file;
}

describe('codexAdapter', () => {
  it('kind=codex,capabilities 全 false', () => {
    expect(adapter.kind).toBe('codex');
    expect(adapter.capabilities).toEqual({
      effort: false,
      askHook: false,
      hud: false,
      rewind: false,
      presetSessionId: false,
      paneRunningSignal: false,
    });
  });

  it('buildLaunchCmd 原样回 launchCommand', () => {
    expect(adapter.buildLaunchCmd({ launchCommand: 'codex --yolo', sessionId: 'x' }))
      .toBe('codex --yolo');
    expect(adapter.buildLaunchCmd({ launchCommand: 'codex --yolo --model gpt-5.4', sessionId: 'x' }))
      .toBe('codex --yolo --model gpt-5.4');
  });

  it('buildResumeCmd 固定模板,忽略 launchCommand 自定义 flag', () => {
    const sid = '11111111-1111-1111-1111-111111111111';
    expect(adapter.buildResumeCmd({ launchCommand: 'codex --yolo --model gpt-5.4', sessionId: sid }))
      .toBe(`codex resume --yolo ${sid}`);
  });

  it('locateTranscript:命中 UUID 对应文件;未命中返回 null', () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-locate-${Date.now()}-${Math.random()}`);
    const sid = '33333333-3333-3333-3333-333333333333';
    const cwd = '/tmp/project-a';
    const file = writeRollout(tmpHome, sid, cwd);
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    expect(adapterT.locateTranscript(sid, os.userInfo().username, cwd)).toBe(file);
    expect(adapterT.locateTranscript('44444444-4444-4444-4444-444444444444', os.userInfo().username, '/tmp')).toBeNull();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('locateTranscript:同 UUID 但 cwd 不匹配时返回 null', () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-locate-cwd-${Date.now()}-${Math.random()}`);
    const sid = '34343434-3434-3434-3434-343434343434';
    writeRollout(tmpHome, sid, '/mnt/llm_eval_fi/moe-ft');
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    expect(adapterT.locateTranscript(sid, os.userInfo().username, '/mnt/wangleyan/workspace/thesis')).toBeNull();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('makeTranscriptTail 提供 setSessionId 钩子,sid 切换时 tail 切到新文件', () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-tail-${Date.now()}-${Math.random()}`);
    const sid1 = '55555555-5555-5555-5555-555555555555';
    const sid2 = '66666666-6666-6666-6666-666666666666';
    const cwd = '/tmp/project-tail';
    writeRollout(
      tmpHome,
      sid1,
      cwd,
      [JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sid1-msg' }] } })],
      Date.now(),
    );
    writeRollout(
      tmpHome,
      sid2,
      cwd,
      [JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sid2-msg' }] } })],
      Date.now() + 1,
    );
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    const tail = adapterT.makeTranscriptTail(sid1, os.userInfo().username, cwd);
    expect(tail.activeChain()[0]?.blocks[0]).toMatchObject({ type: 'text', text: 'sid1-msg' });
    const tailExt = tail as typeof tail & { setSessionId?: (sid: string) => void };
    expect(typeof tailExt.setSessionId).toBe('function');
    tailExt.setSessionId?.(sid2);
    expect(tail.activeChain()[0]?.blocks[0]).toMatchObject({ type: 'text', text: 'sid2-msg' });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('discoverSessionId:扫到 mtime >= startedAt 的 rollout-*-<uuid>.jsonl', async () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-disc-${Date.now()}-${Math.random()}`);
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    const startedAt = Date.now();
    const sid = '22222222-2222-2222-2222-222222222222';
    // 异步在 200ms 后写文件,模拟 codex 启动后写出 rollout
    setTimeout(() => {
      writeRollout(tmpHome, sid, '/tmp/current-project');
    }, 200);
    const got = await adapterT.discoverSessionId({
      tentativeSessionId: 'placeholder',
      unixUser: os.userInfo().username,
      cwd: '/tmp/current-project',
      timeoutMs: 2000,
      startedAt,
    });
    expect(got).toBe(sid);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('discoverSessionId:忽略同 HOME 下更晚写入但 cwd 不匹配的 rollout', async () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-disc-cwd-${Date.now()}-${Math.random()}`);
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    const startedAt = Date.now() - 10;
    const currentSid = '77777777-7777-7777-7777-777777777777';
    const otherSid = '88888888-8888-8888-8888-888888888888';
    writeRollout(tmpHome, currentSid, '/mnt/wangleyan/workspace/thesis', [], startedAt + 50);
    writeRollout(tmpHome, otherSid, '/mnt/llm_eval_fi/moe-ft', [], startedAt + 100);

    const got = await adapterT.discoverSessionId({
      tentativeSessionId: 'placeholder',
      unixUser: os.userInfo().username,
      cwd: '/mnt/wangleyan/workspace/thesis',
      timeoutMs: 300,
      startedAt,
    });
    expect(got).toBe(currentSid);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('discoverSessionId:旧 rollout 后续写入导致 mtime 变新也不能被当成本次新会话', async () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-disc-mtime-${Date.now()}-${Math.random()}`);
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    const cwd = '/tmp/current-project';
    const oldSid = '12121212-1212-1212-1212-121212121212';
    const newSid = '23232323-2323-2323-2323-232323232323';
    const startedAt = Date.now();
    const oldFile = writeRollout(tmpHome, oldSid, cwd, [], startedAt - 60_000);
    fs.utimesSync(oldFile, new Date(startedAt + 500), new Date(startedAt + 500));
    setTimeout(() => {
      writeRollout(tmpHome, newSid, cwd, [], startedAt + 800);
    }, 100);

    const got = await adapterT.discoverSessionId({
      tentativeSessionId: 'placeholder',
      unixUser: os.userInfo().username,
      cwd,
      timeoutMs: 2000,
      startedAt,
    });
    expect(got).toBe(newSid);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('discoverSessionId:排除已经登记给其它会话的 UUID', async () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-disc-exclude-${Date.now()}-${Math.random()}`);
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    const cwd = '/tmp/current-project';
    const startedAt = Date.now();
    const existingSid = '45454545-4545-4545-4545-454545454545';
    const newSid = '56565656-5656-5656-5656-565656565656';
    writeRollout(tmpHome, newSid, cwd, [], startedAt + 100);
    writeRollout(tmpHome, existingSid, cwd, [], startedAt + 300);

    const got = await adapterT.discoverSessionId({
      tentativeSessionId: 'placeholder',
      excludeSessionIds: [existingSid],
      unixUser: os.userInfo().username,
      cwd,
      timeoutMs: 300,
      startedAt,
    });
    expect(got).toBe(newSid);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('discoverSessionId 超时返回 null', async () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-timeout-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmpHome, { recursive: true });
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    const got = await adapterT.discoverSessionId({
      tentativeSessionId: 'placeholder',
      unixUser: os.userInfo().username,
      cwd: '/tmp',
      timeoutMs: 300,
      startedAt: Date.now(),
    });
    expect(got).toBeNull();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('parseToolUseEvents 总返回空(codex 不接 ① 信号)', () => {
    expect(adapter.parseToolUseEvents('whatever')).toEqual([]);
  });
});
