import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCodexAdapter } from './codexAdapter';

const adapter = makeCodexAdapter({
  serviceUser: os.userInfo().username,
  homeFor: (u: string) => (u === os.userInfo().username ? os.homedir() : `/home/${u}`),
});

describe('codexAdapter', () => {
  it('kind=codex,capabilities 全 false', () => {
    expect(adapter.kind).toBe('codex');
    expect(adapter.capabilities).toEqual({
      effort: false,
      askHook: false,
      hud: false,
      rewind: false,
      presetSessionId: false,
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
    const d = new Date();
    const dir = path.join(
      tmpHome, '.codex', 'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${Date.now()}-${sid}.jsonl`);
    fs.writeFileSync(file, '');
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    expect(adapterT.locateTranscript(sid, os.userInfo().username, '/tmp')).toBe(file);
    expect(adapterT.locateTranscript('44444444-4444-4444-4444-444444444444', os.userInfo().username, '/tmp')).toBeNull();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('makeTranscriptTail 提供 setSessionId 钩子,sid 切换时 tail 切到新文件', () => {
    const tmpHome = path.join(os.tmpdir(), `rcc-codex-tail-${Date.now()}-${Math.random()}`);
    const sid1 = '55555555-5555-5555-5555-555555555555';
    const sid2 = '66666666-6666-6666-6666-666666666666';
    const d = new Date();
    const dir = path.join(
      tmpHome, '.codex', 'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `rollout-${Date.now()}-${sid1}.jsonl`),
      JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sid1-msg' }] } }) + '\n',
    );
    fs.writeFileSync(
      path.join(dir, `rollout-${Date.now() + 1}-${sid2}.jsonl`),
      JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sid2-msg' }] } }) + '\n',
    );
    const adapterT = makeCodexAdapter({
      serviceUser: os.userInfo().username,
      homeFor: () => tmpHome,
    });
    const tail = adapterT.makeTranscriptTail(sid1, os.userInfo().username, '/tmp');
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
      const d = new Date();
      const dir = path.join(
        tmpHome, '.codex', 'sessions',
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `rollout-${Date.now()}-${sid}.jsonl`), '{}\n');
    }, 200);
    const got = await adapterT.discoverSessionId({
      tentativeSessionId: 'placeholder',
      unixUser: os.userInfo().username,
      cwd: '/tmp',
      timeoutMs: 2000,
      startedAt,
    });
    expect(got).toBe(sid);
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
