import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askSidecarPath, readPendingAsk, toAskPending, type AskHookPending } from './askSidecar';

const PENDING: AskHookPending = {
  toolUseId: 'toolu_1',
  ts: 123,
  questions: [
    {
      question: 'Pick a fruit',
      header: 'Fruit',
      multiSelect: false,
      options: [
        { label: 'Apple', description: '苹果' },
        { label: 'Banana' },
      ],
    },
    {
      question: 'Pick a color',
      multiSelect: true,
      options: [{ label: 'Red' }, { label: 'Green' }],
    },
  ],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rcc-sidecar-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('askSidecar.readPendingAsk', () => {
  it('读出合法 sidecar', () => {
    writeFileSync(askSidecarPath(dir, 'sess'), JSON.stringify(PENDING));
    expect(readPendingAsk(dir, 'sess')).toEqual(PENDING);
  });
  it('文件缺失 → null', () => {
    expect(readPendingAsk(dir, 'ghost')).toBeNull();
  });
  it('坏 JSON → null', () => {
    writeFileSync(askSidecarPath(dir, 'sess'), 'not json');
    expect(readPendingAsk(dir, 'sess')).toBeNull();
  });
});

describe('askSidecar.toAskPending', () => {
  it('映射第 0 题：含 description/question/header/qIndex/qTotal', () => {
    expect(toAskPending(PENDING, 0)).toEqual({
      question: 'Pick a fruit',
      header: 'Fruit',
      multiSelect: false,
      qIndex: 0,
      qTotal: 2,
      options: [
        { index: 0, label: 'Apple', description: '苹果' },
        { index: 1, label: 'Banana' },
      ],
    });
  });
  it('映射第 1 题：无 header、多选、无 description', () => {
    expect(toAskPending(PENDING, 1)).toEqual({
      question: 'Pick a color',
      multiSelect: true,
      qIndex: 1,
      qTotal: 2,
      options: [
        { index: 0, label: 'Red' },
        { index: 1, label: 'Green' },
      ],
    });
  });
});
