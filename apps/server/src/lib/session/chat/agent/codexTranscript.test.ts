import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexTranscriptTail, parseCodexLine } from './codexTranscript';

describe('parseCodexLine', () => {
  it('用户消息(response_item message role=user)→ ChatMessage role=user', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我写代码' }] },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('user');
    expect(r?.blocks).toEqual([{ type: 'text', text: '帮我写代码' }]);
  });

  it('agent_message(event_msg)→ ChatMessage role=assistant', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:01Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: '好的我开始' },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('assistant');
    expect(r?.blocks).toEqual([{ type: 'text', text: '好的我开始' }]);
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
    expect(r?.blocks[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'exec_command' });
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

  it('reasoning(response_item)→ assistant 块 thinking', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-25T00:00:04Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: '让我想想' }] },
    });
    const r = parseCodexLine(line);
    expect(r?.role).toBe('assistant');
    expect(r?.blocks[0]).toMatchObject({ type: 'thinking', text: '让我想想' });
  });

  it('session_meta / turn_context / token_count → null(不渲染)', () => {
    expect(parseCodexLine(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'turn_context', payload: {} }))).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }))).toBeNull();
  });

  it('坏 JSON → null(不挂掉整个流)', () => {
    expect(parseCodexLine('{not json')).toBeNull();
    expect(parseCodexLine('')).toBeNull();
  });
});

describe('CodexTranscriptTail.activeChain', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `rcc-codex-tail-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('按时间戳顺序还原可渲染消息', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ timestamp: '2026-06-25T00:00:00Z', type: 'session_meta', payload: {} }),
      JSON.stringify({ timestamp: '2026-06-25T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
      JSON.stringify({ timestamp: '2026-06-25T00:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } }),
    ].join('\n') + '\n');
    const tail = new CodexTranscriptTail(() => file);
    const chain = tail.activeChain();
    expect(chain.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chain[0].blocks[0]).toMatchObject({ type: 'text', text: 'hi' });
    expect(chain[1].blocks[0]).toMatchObject({ type: 'text', text: 'hello' });
  });

  it('增量 ingest:append 新行只解析新内容', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'agent_message', message: 'a' } }) + '\n');
    const tail = new CodexTranscriptTail(() => file);
    expect(tail.activeChain().length).toBe(1);
    fs.appendFileSync(file, JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'agent_message', message: 'b' } }) + '\n');
    const chain = tail.activeChain();
    expect(chain.length).toBe(2);
    expect(chain[1].blocks[0]).toMatchObject({ type: 'text', text: 'b' });
  });

  it('getPath 返回 null 时 activeChain 返回空', () => {
    const tail = new CodexTranscriptTail(() => null);
    expect(tail.activeChain()).toEqual([]);
  });

  it('lastAssistantUsage 从 token_count event_msg 取', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      timestamp: 't1', type: 'event_msg',
      payload: { type: 'token_count', input_tokens: 100, output_tokens: 50 },
    }) + '\n');
    const tail = new CodexTranscriptTail(() => file);
    tail.activeChain();  // 触发 ingest
    const usage = tail.lastAssistantUsage?.();
    expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it('reset 清掉偏移和已积累的消息', () => {
    const file = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'agent_message', message: 'a' } }) + '\n');
    const tail = new CodexTranscriptTail(() => file);
    expect(tail.activeChain().length).toBe(1);
    tail.reset();
    expect(tail.activeChain().length).toBe(1);  // reset 后重读还是能拿到
  });
});
