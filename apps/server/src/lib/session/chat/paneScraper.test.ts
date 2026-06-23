import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { scrapePane } from './paneScraper';

const fx = (n: string) => readFileSync(join(__dirname, '../__fixtures__', n), 'utf8');

describe('scrapePane', () => {
  it('boot：无预览、未运行、未完成', () => {
    const r = scrapePane(fx('pane_boot.txt'));
    expect(r.preview).toBe('');
    expect(r.spinner).toBe(false);
    expect(r.done).toBe(false);
  });

  it('spinner：检测到运行 spinner，尚无正文', () => {
    const r = scrapePane(fx('pane_spinner.txt'));
    expect(r.spinner).toBe(true);
    expect(r.done).toBe(false);
    expect(r.preview).toBe('');
  });

  it('streaming：抽出已生成正文、剥掉 chrome', () => {
    const r = scrapePane(fx('pane_streaming.txt'));
    expect(r.preview).toContain('二叉搜索树');
    expect(r.preview).toContain('1.');
    expect(r.preview).not.toContain('●');
    expect(r.preview).not.toContain('❯');
    expect(r.preview).not.toMatch(/bypass permissions/);
    expect(r.preview).not.toContain('Claude Code v2');
    expect(r.done).toBe(false);
  });

  it('complete：完整正文、done=true、无 chrome/完成行', () => {
    const r = scrapePane(fx('pane_complete.txt'));
    expect(r.preview).toContain('红黑树');
    expect(r.preview).toContain('5.');
    expect(r.done).toBe(true);
    expect(r.preview).not.toContain('Cooked');
    expect(r.preview).not.toContain('───');
    expect(r.preview).not.toContain('❯');
  });

  it('多轮：只取最后一个 ❯ 之后的最新一轮，不含上一轮回复', () => {
    const pane = [
      '❯ 第一个问题',
      '',
      '● 这是第一轮的回复内容。',
      '',
      '❯ 第二个问题',
      '',
      '● 这是第二轮的回复内容。',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');
    const r = scrapePane(pane);
    expect(r.preview).toContain('第二轮的回复');
    expect(r.preview).not.toContain('第一轮的回复');
    expect(r.preview).not.toContain('第二个问题'); // 用户文字不进预览
  });

  it('刚发出消息、助手尚未回复：预览为空（不把用户文字当回复）', () => {
    const pane = [
      '❯ 第一个问题',
      '',
      '● 这是第一轮的回复内容。',
      '',
      '❯ 刚发出的新问题',
      '',
      '✽ Slithering…',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');
    const r = scrapePane(pane);
    expect(r.preview).toBe('');
    expect(r.spinner).toBe(true);
  });
});
