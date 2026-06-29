/**
 * 中文 FTS5 兼容层:unicode61 tokenizer 默认完全丢弃 CJK 字符,
 * trigram 又要求 ≥3 字才能匹配。中文用户最常输入 2 字关键词("字体"/"性能"),
 * 故采用"入库 + 查询都把 CJK 字符两侧加空格"的方案:
 *   - 入库:expandCjk("我搞字体") → "我 搞 字 体",unicode61 当作西文 token
 *   - 查询:expandCjk("字体") → "字 体",包成 phrase `"字 体"` 强制连续匹配
 *   - 展示:snippet 返回的 "<mark>字</mark> <mark>体</mark> 的" 用 collapseCjkSpaces 去掉
 *     CJK 之间的空格,恢复原文呈现
 *
 * 范围:CJK Unified Ideographs U+4E00-U+9FFF(覆盖简体/繁体常用字)+ 兼容扩展。
 * ASCII / 数字 / 标点 不动,由 unicode61 自己处理 token 边界。
 */

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;
const CJK_CLASS = '[㐀-䶿一-鿿豈-﫿]';

/** 给每个 CJK 字符两侧加空格(已邻接空格不重复)。供入库/查询前调用。 */
export function expandCjk(s: string): string {
  if (!s) return '';
  return s.replace(CJK_RE, ' $& ').replace(/\s+/g, ' ').trim();
}

/** 还原:把连续 CJK 字符之间的空格去掉(snippet 展示时调);
 *  保留 ASCII 之间 / ASCII-CJK 边界的空格(那些是原文真有的)。
 *  FTS5 snippet 用 <mark>…</mark> 把每个命中字包起来,被 mark 标签隔开的相邻 CJK 也算"邻接",
 *  一并合并:`<mark>字</mark> <mark>体</mark>` → `<mark>字</mark><mark>体</mark>`,显示干净。 */
export function collapseCjkSpaces(s: string): string {
  if (!s) return '';
  const reCjkCjk = new RegExp(`(${CJK_CLASS})\\s+(${CJK_CLASS})`, 'g');
  const reCjkMark = new RegExp(`(${CJK_CLASS})\\s+(?=<mark>)`, 'g');
  const reMarkCjkOrMark = new RegExp(`(</mark>)\\s+(?=${CJK_CLASS}|<mark>)`, 'g');
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(reCjkCjk, '$1$2');
    cur = cur.replace(reCjkMark, '$1');
    cur = cur.replace(reMarkCjkOrMark, '$1');
  } while (cur !== prev);
  return cur;
}

/**
 * 把用户原始 query 转为 FTS5 MATCH 表达式。
 * - 含 CJK 的 query 走 expandCjk + phrase 包裹保证语义("字体" → `"字 体"`)
 * - 纯英文/数字 query 透传(unicode61 自己处理)
 * - 含可能造成 FTS 语法错误的字符(双引号、星号、冒号等)做转义/剥离
 */
export function toFtsMatchExpr(rawQuery: string): string {
  // FTS5 特殊字符:" * ( ) - + ^ : 等;直接 strip 防注入
  const cleaned = rawQuery.replace(/["*()\-+^:]/g, ' ').trim();
  if (!cleaned) return '""';
  const expanded = expandCjk(cleaned);
  return `"${expanded}"`;
}
