import { describe, it, expect } from 'vitest';
import { parseSgr, stripMouseTracking } from './ansi';

describe('parseSgr', () => {
  it('纯文本 → 单段无样式', () => {
    expect(parseSgr('hello')).toEqual([{ text: 'hello' }]);
  });

  it('基础前景色 31=红，0 复位', () => {
    const segs = parseSgr('\x1b[31mRED\x1b[0mX');
    expect(segs).toEqual([
      { text: 'RED', fg: '#cd0000' },
      { text: 'X' },
    ]);
  });

  it('前置普通字符 + 256 色 208=橙', () => {
    const segs = parseSgr('X\x1b[38;5;208mORANGE\x1b[0m');
    // 208: 208-16=192 → r5 g2 b0 → [255,135,0]
    expect(segs[0]).toEqual({ text: 'X' });
    expect(segs[1]).toEqual({ text: 'ORANGE', fg: 'rgb(255,135,0)' });
  });

  it('加粗 + 亮绿(1;32)', () => {
    const segs = parseSgr('\x1b[1;32mGRN\x1b[0m');
    expect(segs[0]).toEqual({ text: 'GRN', fg: '#00cd00', bold: true });
  });

  it('truecolor 38;2;r;g;b', () => {
    const segs = parseSgr('\x1b[38;2;10;20;30mT');
    expect(segs[0]).toEqual({ text: 'T', fg: 'rgb(10,20,30)' });
  });

  it('背景色 41 + 复位 49', () => {
    const segs = parseSgr('\x1b[41mB\x1b[49mC');
    expect(segs[0]).toEqual({ text: 'B', bg: '#cd0000' });
    expect(segs[1]).toEqual({ text: 'C' });
  });

  it('忽略未知 SGR(如下划线 4)且不丢文本', () => {
    expect(parseSgr('\x1b[4mU\x1b[0m')).toEqual([{ text: 'U' }]);
  });

  it('跳过非 SGR 转义(不当作文本输出)', () => {
    // \x1b[2K 是清行,非 m 结尾 → 跳过
    expect(parseSgr('\x1b[2KAB')).toEqual([{ text: 'AB' }]);
  });

  it('空文本段不产出', () => {
    expect(parseSgr('\x1b[31m\x1b[0m')).toEqual([]);
  });
});

describe('stripMouseTracking', () => {
  it('去掉单个鼠标上报开启序列', () => {
    expect(stripMouseTracking('a\x1b[?1002hb')).toBe('ab');
    expect(stripMouseTracking('\x1b[?1000h')).toBe('');
    expect(stripMouseTracking('\x1b[?1003h')).toBe('');
  });
  it('保留非鼠标的 DECSET(如备用屏 1049)', () => {
    expect(stripMouseTracking('\x1b[?1049h')).toBe('\x1b[?1049h');
    expect(stripMouseTracking('\x1b[?25l')).toBe('\x1b[?25l');
  });
  it('组合序列里只摘掉鼠标号、保留其余', () => {
    expect(stripMouseTracking('\x1b[?1049;1002h')).toBe('\x1b[?1049h');
    expect(stripMouseTracking('\x1b[?1002;1006h')).toBe('\x1b[?1006h');
    expect(stripMouseTracking('\x1b[?1000;1002;1003h')).toBe(''); // 全是鼠标号 → 整段去掉
  });
  it('一段里多个、且不碰普通文本/SGR', () => {
    expect(stripMouseTracking('x\x1b[?1002h\x1b[31mY\x1b[0m\x1b[?1003hz')).toBe('x\x1b[31mY\x1b[0mz');
  });
  it('不误伤含 100x 但非 1000-1003 的号(如 1006/1015)', () => {
    expect(stripMouseTracking('\x1b[?1006h')).toBe('\x1b[?1006h');
    expect(stripMouseTracking('\x1b[?1015h')).toBe('\x1b[?1015h');
  });
});
