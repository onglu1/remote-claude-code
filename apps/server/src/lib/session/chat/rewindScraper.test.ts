import { describe, it, expect } from 'vitest';
import { parseRewindPicker } from './rewindScraper';

// 以下均取自真实 spike（claude 2.1.141）的 capture-pane 文本。

const LIST_CUR = [
  '  Rewind',
  '',
  '  Restore the code and/or conversation to the point before…',
  '',
  '    Create a file named note.txt containing the single word hello, then reply exactly: done',
  '    note.txt +2',
  '',
  '  ❯ (current)',
  '',
  '',
  '',
  '  Enter to continue · Esc to cancel',
].join('\n');

const LIST_SEL = [
  '  Rewind',
  '',
  '  Restore the code and/or conversation to the point before…',
  '',
  '  ❯ Create a file named note.txt containing the single word hello, then reply exactly: done',
  '    note.txt +2',
  '',
  '    (current)',
  '',
  '  Enter to continue · Esc to cancel',
].join('\n');

const LIST_TWO = [
  '  Rewind',
  '',
  '  Restore the code and/or conversation to the point before…',
  '',
  '    First prompt here',
  '    a.txt +3',
  '',
  '  ❯ Second prompt here',
  '    b.txt +1 -2',
  '',
  '    (current)',
  '',
  '  Enter to continue · Esc to cancel',
].join('\n');

const MODE_1 = [
  '  Rewind',
  '',
  '  Confirm you want to restore to the point before you sent this message:',
  '',
  '  │ Create a file named note.txt …',
  '  │ (47s ago)',
  '',
  '  The conversation will be forked.',
  '  The code will be restored -1 in note.txt.',
  '',
  '  ❯ 1. Restore code and conversation',
  '    2. Restore conversation',
  '    3. Restore code',
  '    4. Summarize from here',
  '  ↓ 5. Summarize up to here',
  '',
  '  ⚠ Rewinding does not affect files edited manually or via bash.',
].join('\n');

const MODE_2 = [
  '  Rewind',
  '',
  '  Confirm you want to restore to the point before you sent this message:',
  '',
  '  │ Create a file named note.txt …',
  '  │ (1m ago)',
  '',
  '  The conversation will be forked.',
  '  The code will be unchanged.',
  '',
  '    1. Restore code and conversation',
  '  ❯ 2. Restore conversation',
  '    3. Restore code',
  '    4. Summarize from here',
  '  ↓ 5. Summarize up to here',
  '',
  '  ⚠ Rewinding does not affect files edited manually or via bash.',
].join('\n');

const NOT_PICKER = ['❯ ', '  [opus] ░░ 3% | x', '  ⏵⏵ bypass permissions on'].join('\n');

describe('parseRewindPicker', () => {
  it('列表：单 checkpoint，光标在 (current)', () => {
    const s = parseRewindPicker(LIST_CUR);
    expect(s.open).toBe(true);
    expect(s.stage).toBe('list');
    expect(s.items).toHaveLength(1);
    expect(s.items[0].label).toContain('Create a file');
    expect(s.items[0].changes).toBe('note.txt +2');
    expect(s.cursor).toBe(1); // == items.length → (current)
  });

  it('列表：光标在 checkpoint 行 → cursor=0', () => {
    expect(parseRewindPicker(LIST_SEL).cursor).toBe(0);
  });

  it('列表：两个 checkpoint，光标在第二个', () => {
    const s = parseRewindPicker(LIST_TWO);
    expect(s.items.map((i) => i.index)).toEqual([0, 1]);
    expect(s.items[1].label).toBe('Second prompt here');
    expect(s.items[1].changes).toBe('b.txt +1 -2');
    expect(s.cursor).toBe(1);
  });

  it('模式：编号选项，光标在 1，代码影响=restored -1', () => {
    const s = parseRewindPicker(MODE_1);
    expect(s.stage).toBe('mode');
    expect(s.modeCursor).toBe(1);
    expect(s.codeEffect).toContain('restored -1');
    expect(s.modeOptions).toEqual([
      { num: 1, mode: 'both' },
      { num: 2, mode: 'conversation' },
      { num: 3, mode: 'code' },
    ]);
  });

  it('模式：光标在 2（仅对话），代码影响=unchanged', () => {
    const s = parseRewindPicker(MODE_2);
    expect(s.stage).toBe('mode');
    expect(s.modeCursor).toBe(2);
    expect(s.codeEffect).toContain('unchanged');
  });

  it('非 picker 屏 → open=false / stage=none', () => {
    const s = parseRewindPicker(NOT_PICKER);
    expect(s.open).toBe(false);
    expect(s.stage).toBe('none');
  });
});
