import { describe, it, expect } from 'vitest';
import { decodeChatClient, encodeChatServer } from './chatWs';

describe('chatWs', () => {
  it('解析 user_text', () => {
    expect(decodeChatClient(JSON.stringify({ type: 'user_text', text: 'hi' }))).toEqual({
      type: 'user_text',
      text: 'hi',
    });
  });

  it('解析 key', () => {
    expect(decodeChatClient(JSON.stringify({ type: 'key', key: 'esc' }))).toEqual({
      type: 'key',
      key: 'esc',
    });
  });

  it('解析 image', () => {
    const msg = { type: 'image', dataB64: 'AAAA', mime: 'image/png', name: 'a.png' };
    expect(decodeChatClient(JSON.stringify(msg))).toEqual(msg);
  });

  it('解析 set_effort / rewind_execute', () => {
    expect(decodeChatClient(JSON.stringify({ type: 'set_effort', level: 'high' }))).toEqual({
      type: 'set_effort',
      level: 'high',
    });
    expect(decodeChatClient(JSON.stringify({ type: 'rewind_execute', index: 2, mode: 'conversation' }))).toEqual({
      type: 'rewind_execute',
      index: 2,
      mode: 'conversation',
    });
    expect(decodeChatClient(JSON.stringify({ type: 'rewind_execute', index: 0, mode: 'bogus' }))).toBeNull();
  });

  it('解析 ask_answer（单选/多选）', () => {
    const single = { type: 'ask_answer', toolUseId: 't1', picks: [{ questionIndex: 0, optionIndices: [1] }] };
    expect(decodeChatClient(JSON.stringify(single))).toEqual(single);
    const multi = { type: 'ask_answer', toolUseId: 't2', picks: [{ questionIndex: 0, optionIndices: [0, 2] }, { questionIndex: 1, optionIndices: [1] }] };
    expect(decodeChatClient(JSON.stringify(multi))).toEqual(multi);
  });

  it('拒绝缺 picks 的 ask_answer', () => {
    expect(decodeChatClient(JSON.stringify({ type: 'ask_answer', toolUseId: 't1' }))).toBeNull();
  });

  it('编码 ask_state', () => {
    expect(JSON.parse(encodeChatServer({ type: 'ask_state', toolUseId: 't1', status: 'driving' }))).toEqual({
      type: 'ask_state',
      toolUseId: 't1',
      status: 'driving',
    });
  });

  it('解析 ask_pending_answer（实时待答作答）', () => {
    const m = { type: 'ask_pending_answer', optionIndices: [1] };
    expect(decodeChatClient(JSON.stringify(m))).toEqual(m);
    const multi = { type: 'ask_pending_answer', optionIndices: [0, 2] };
    expect(decodeChatClient(JSON.stringify(multi))).toEqual(multi);
  });

  it('编码 ask_pending / clear / failed', () => {
    expect(JSON.parse(encodeChatServer({ type: 'ask_pending', options: [{ index: 0, label: 'Apple' }], multiSelect: false }))).toEqual({
      type: 'ask_pending',
      options: [{ index: 0, label: 'Apple' }],
      multiSelect: false,
    });
    expect(JSON.parse(encodeChatServer({ type: 'ask_pending_clear' }))).toEqual({ type: 'ask_pending_clear' });
    expect(JSON.parse(encodeChatServer({ type: 'ask_pending_failed', error: 'x' }))).toEqual({ type: 'ask_pending_failed', error: 'x' });
  });

  it('ask_pending 携带问题正文/说明/多问题进度往返', () => {
    // 直接传字面量：触发 TS 多余属性检查，新字段缺类型时 typecheck 会失败（RED）。
    const expected = {
      type: 'ask_pending',
      question: 'Pick a fruit',
      header: 'Fruit',
      qIndex: 0,
      qTotal: 2,
      multiSelect: false,
      options: [
        { index: 0, label: 'Apple', description: '苹果' },
        { index: 1, label: 'Banana' },
      ],
    };
    expect(
      JSON.parse(
        encodeChatServer({
          type: 'ask_pending',
          question: 'Pick a fruit',
          header: 'Fruit',
          qIndex: 0,
          qTotal: 2,
          multiSelect: false,
          options: [
            { index: 0, label: 'Apple', description: '苹果' },
            { index: 1, label: 'Banana' },
          ],
        }),
      ),
    ).toEqual(expected);
  });

  it('拒绝非法 type / 非法 key / 坏 JSON', () => {
    expect(decodeChatClient('{"type":"nope"}')).toBeNull();
    expect(decodeChatClient(JSON.stringify({ type: 'key', key: 'f1' }))).toBeNull();
    expect(decodeChatClient('not json')).toBeNull();
  });

  it('编码 server 消息', () => {
    expect(JSON.parse(encodeChatServer({ type: 'preview', text: 'x' }))).toEqual({
      type: 'preview',
      text: 'x',
    });
    expect(JSON.parse(encodeChatServer({ type: 'turn_state', running: true }))).toEqual({
      type: 'turn_state',
      running: true,
    });
  });
});
