import { describe, it, expect } from 'vitest';
import { typeToDir, dirToType, parseId, idToPath, isValidNumber } from './nodeId';

describe('typeToDir / dirToType', () => {
  it('五类型 ↔ 目录名互转', () => {
    expect(typeToDir('thread')).toBe('threads');
    expect(typeToDir('evidence')).toBe('evidence');
    expect(typeToDir('reference')).toBe('references');
    expect(dirToType('tasks')).toBe('task');
    expect(dirToType('evidence')).toBe('evidence');
    expect(dirToType('unknown')).toBeUndefined();
  });
});

describe('parseId', () => {
  it('拆出 type 与编号', () => {
    expect(parseId('task/007')).toEqual({ type: 'task', number: '007' });
    expect(parseId('reference/vaswani2017')).toEqual({ type: 'reference', number: 'vaswani2017' });
  });
  it('拒绝缺 / 或缺编号或非法 type', () => {
    expect(() => parseId('task')).toThrow();
    expect(() => parseId('task/')).toThrow();
    expect(() => parseId('paper/1')).toThrow();
  });
});

describe('idToPath', () => {
  it('映射到 research/nodes 下的 JSON 路径', () => {
    expect(idToPath('task/007')).toBe('research/nodes/tasks/007.json');
    expect(idToPath('thread/003')).toBe('research/nodes/threads/003.json');
    expect(idToPath('reference/vaswani2017')).toBe('research/nodes/references/vaswani2017.json');
  });
});

describe('isValidNumber', () => {
  it('接受 3 位主编号与子编号', () => {
    expect(isValidNumber('007')).toBe(true);
    expect(isValidNumber('025.1')).toBe(true);
  });
  it('reference 的 citekey 视作合法编号(非空、无斜杠空格)', () => {
    expect(isValidNumber('vaswani2017')).toBe(true);
  });
  it('拒绝空 / 含斜杠 / 含空格', () => {
    expect(isValidNumber('')).toBe(false);
    expect(isValidNumber('a/b')).toBe(false);
    expect(isValidNumber('a b')).toBe(false);
  });
});
