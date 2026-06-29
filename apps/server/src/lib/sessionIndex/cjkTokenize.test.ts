import { describe, it, expect } from 'vitest';
import { expandCjk, collapseCjkSpaces, toFtsMatchExpr } from './cjkTokenize';

describe('expandCjk', () => {
  it('每个 CJK 字符两侧加空格', () => {
    expect(expandCjk('字体')).toBe('字 体');
    expect(expandCjk('我搞统一字体')).toBe('我 搞 统 一 字 体');
  });
  it('英文/数字/空格不动', () => {
    expect(expandCjk('hello world')).toBe('hello world');
    expect(expandCjk('npm test 123')).toBe('npm test 123');
  });
  it('中英混合', () => {
    expect(expandCjk('fix 字体 bug')).toBe('fix 字 体 bug');
  });
  it('空串 → 空串', () => {
    expect(expandCjk('')).toBe('');
  });
});

describe('collapseCjkSpaces', () => {
  it('CJK 间空格去掉', () => {
    expect(collapseCjkSpaces('字 体')).toBe('字体');
    expect(collapseCjkSpaces('我 搞 字 体')).toBe('我搞字体');
  });
  it('英文间空格保留', () => {
    expect(collapseCjkSpaces('hello world')).toBe('hello world');
  });
  it('中英混合:CJK-CJK 去 / CJK-ASCII 保留', () => {
    expect(collapseCjkSpaces('fix 字 体 bug')).toBe('fix 字体 bug');
  });
  it('FTS5 snippet mark 标签内的字也能合', () => {
    expect(collapseCjkSpaces('<mark>字</mark> <mark>体</mark> 的')).toBe('<mark>字</mark><mark>体</mark>的');
  });
});

describe('toFtsMatchExpr', () => {
  it('中文 query 包成 phrase', () => {
    expect(toFtsMatchExpr('字体')).toBe('"字 体"');
  });
  it('英文 query 也包成 phrase(无害)', () => {
    expect(toFtsMatchExpr('hello')).toBe('"hello"');
  });
  it('剥离 FTS5 特殊字符防注入', () => {
    // " 和 * 都应被剥离 → 中文部分被 expandCjk 展开,外层只剩一对包裹引号
    expect(toFtsMatchExpr('"恶意" * 字体')).toBe('"恶 意 字 体"');
    // 内层不应再出现用户原始的 " 或 *
    const r = toFtsMatchExpr('"恶意" * 字体');
    expect(r.startsWith('"') && r.endsWith('"')).toBe(true);
    const inner = r.slice(1, -1);
    expect(inner.includes('"')).toBe(false);
    expect(inner.includes('*')).toBe(false);
  });
  it('空 query → 空 phrase', () => {
    expect(toFtsMatchExpr('')).toBe('""');
    expect(toFtsMatchExpr('   ')).toBe('""');
  });
});
