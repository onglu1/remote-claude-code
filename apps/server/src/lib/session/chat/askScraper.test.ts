import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseAskPicker, parseAskPickerLive } from './askScraper';

const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');

describe('parseAskPicker', () => {
  it('真实单选菜单:open + 选项(编号/标签) + 光标在 1', () => {
    const s = parseAskPicker(fx('ask_single_select.txt'));
    expect(s.open).toBe(true);
    expect(s.options).toEqual([
      { num: 1, label: 'Apple' },
      { num: 2, label: 'Banana' },
      { num: 3, label: 'Type something.' },
      { num: 4, label: 'Chat about this' },
    ]);
    expect(s.cursor).toBe(1);
  });

  it('光标在第二项时 cursor=2', () => {
    const pane = ['Pick a fruit', '  1. Apple', '❯ 2. Banana', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    expect(parseAskPicker(pane)).toMatchObject({ open: true, cursor: 2 });
  });

  it('非菜单屏 → open=false', () => {
    expect(parseAskPicker('just some text\n❯ \n').open).toBe(false);
    expect(parseAskPicker('').open).toBe(false);
  });

  it('不把被回显的长 prompt 句子当成选项', () => {
    const pane = ['❯ Use the AskUserQuestion tool now. 1. apples 2. bananas in a sentence', 'no footer here'].join('\n');
    expect(parseAskPicker(pane).open).toBe(false);
  });
});

describe('parseAskPickerLive（实时待答专属签名）', () => {
  it('真实 ask 屏 → open + 真实选项(过滤追加项) + 单选', () => {
    const s = parseAskPickerLive(fx('ask_single_select.txt'));
    expect(s.open).toBe(true);
    expect(s.options).toEqual([
      { index: 0, label: 'Apple' },
      { index: 1, label: 'Banana' },
    ]);
    expect(s.multiSelect).toBe(false);
  });

  it('rewind 样屏 → 不误判(open=false)', () => {
    const pane = [
      'Restore the code and/or conversation to a previous checkpoint',
      '❯ 1. some checkpoint',
      'Enter to continue · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    expect(parseAskPickerLive(pane).open).toBe(false);
  });

  it('普通文本 → open=false', () => {
    expect(parseAskPickerLive('just text\nno menu').open).toBe(false);
  });

  it('缺少 Chat about this 词缀 → 不判为待答(防误判其他菜单)', () => {
    const pane = ['Pick', '❯ 1. Apple', '  2. Banana', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    expect(parseAskPickerLive(pane).open).toBe(false);
  });
});
