import { describe, it, expect } from 'vitest';
import { computeWindow } from './scrollback';

// 实测基线：H=61, P=10, T=71（见 spec/plan）
describe('computeWindow', () => {
  it('首窗(before=null)取最新一窗，映射到 tmux 行号', () => {
    const w = computeWindow({ historySize: 61, paneHeight: 10, before: null, limit: 50 });
    expect(w.startLine).toBe(-40); // lo=21 → 21-61
    expect(w.endLine).toBe(9); // hi=71 → 70-61
    expect(w.nextBefore).toBe(21);
    expect(w.atTop).toBe(false);
    expect(w.empty).toBe(false);
  });

  it('上一窗收敛到顶', () => {
    const w = computeWindow({ historySize: 61, paneHeight: 10, before: 21, limit: 50 });
    expect(w.startLine).toBe(-61); // lo=0 → 0-61
    expect(w.endLine).toBe(-41); // hi=21 → 20-61
    expect(w.nextBefore).toBe(0);
    expect(w.atTop).toBe(true);
  });

  it('limit 超过总行数 → 一窗到顶', () => {
    const w = computeWindow({ historySize: 0, paneHeight: 5, before: null, limit: 999 });
    expect(w.startLine).toBe(0); // lo=0 → 0-0
    expect(w.endLine).toBe(4); // hi=5 → 4-0
    expect(w.atTop).toBe(true);
    expect(w.empty).toBe(false);
  });

  it('before<=0 → 空窗', () => {
    const w = computeWindow({ historySize: 10, paneHeight: 5, before: 0, limit: 50 });
    expect(w.empty).toBe(true);
    expect(w.atTop).toBe(true);
  });

  it('before 超出上界被夹紧到 T', () => {
    const w = computeWindow({ historySize: 61, paneHeight: 10, before: 9999, limit: 50 });
    expect(w.endLine).toBe(9); // hi 夹到 71 → 70-61
  });

  it('两窗拼接覆盖全部且无重叠(50+21=71)', () => {
    const a = computeWindow({ historySize: 61, paneHeight: 10, before: null, limit: 50 });
    const b = computeWindow({ historySize: 61, paneHeight: 10, before: a.nextBefore, limit: 50 });
    // a 覆盖显示下标 [21,71)=50 行；b 覆盖 [0,21)=21 行；衔接点一致
    expect(a.nextBefore).toBe(b.endLine + 1 + 61); // b 的上界 hi = a.nextBefore
  });
});
