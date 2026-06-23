import fs from 'node:fs';
import path from 'node:path';

/** 旧 task 中间表示。 */
export interface LegacyTask {
  number: string;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'dropped';
  source?: string;
  evidenceLinks: string[]; // 关联到的 evidence 编号(如 '003')
  tags: string[];
}

/** 旧 evidence 中间表示。 */
export interface LegacyEvidence {
  number: string;
  title: string;
  conclusion?: string;
}

export interface ParsedLegacy {
  tasks: LegacyTask[];
  evidence: LegacyEvidence[];
}

interface TableRow { cells: string[]; }

/** 解析 markdown 中的所有表格行(跳过表头、分隔行 |---|)。 */
export function parseTableRows(md: string): TableRow[] {
  const rows: TableRow[] = [];
  let headerSeen = false;
  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      headerSeen = false;
      continue;
    }
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^[-:]+$/.test(c))) { headerSeen = true; continue; }
    if (!headerSeen) continue; // 表头本身,跳过
    rows.push({ cells });
  }
  return rows;
}

/** 从 cell 提取编号(如 '003')。 */
function extractNumber(cell: string): string {
  const m = /\b(\d{3,})\b/.exec(cell);
  return m ? m[1] : '';
}

/** 从 cell 提取首个 markdown link 的文本(去除 ~~~~ 删除线)。 */
function extractTitle(cell: string): string {
  // 去掉删除线
  const c = cell.replace(/~~/g, '');
  // markdown link [text](target)
  const link = /\[([^\]]+)\]\([^)]+\)/.exec(c);
  if (link) return link[1].trim();
  return c.trim().replace(/\s*→.*$/, ''); // 截掉箭头注释
}

/** 推断旧 task 的 status:含 ~~ → dropped or done(看箭头);'已完成' → done;否则 todo。 */
function inferStatus(cell: string): 'todo' | 'doing' | 'done' | 'dropped' {
  const c = cell.replace(/\s+/g, '');
  const struck = /~~.*~~/.test(c);
  if (/已完成|已经完成/.test(c)) return 'done';
  if (/废弃|作废|abandon/i.test(c)) return 'dropped';
  if (struck && /→/.test(c)) return 'done'; // 删除线 + 箭头转向新条目
  if (struck) return 'dropped';
  return 'todo';
}

/** 从 cell 提取所有 evidence 关联编号(看 evidence/<num> 或 'evidence NNN' 或链接到 ../evidence/NNN-*)。 */
function extractEvidenceLinks(cell: string): string[] {
  const out = new Set<string>();
  for (const m of cell.matchAll(/evidence[\/\s]*(\d{3,})/gi)) out.add(m[1]);
  for (const m of cell.matchAll(/\.\.\/evidence\/(\d{3,})/g)) out.add(m[1]);
  return [...out];
}

function readSafe(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 主入口:从 docsDir(相对仓库根) 解析旧 tasks/INDEX.md + evidence/INDEX.md。 */
export function parseLegacyDocs(docsDir: string): ParsedLegacy {
  const tasksMd = readSafe(path.join(docsDir, 'tasks', 'INDEX.md'));
  const evidenceMd = readSafe(path.join(docsDir, 'evidence', 'INDEX.md'));

  const tasks: LegacyTask[] = [];
  for (const row of parseTableRows(tasksMd)) {
    const [numCell, titleCell, _priorityCell, sourceCell] = row.cells;
    const number = extractNumber(numCell ?? '');
    if (!number) continue;
    tasks.push({
      number,
      title: extractTitle(titleCell ?? '') || `(无标题 ${number})`,
      status: inferStatus(titleCell ?? ''),
      source: (sourceCell ?? '').trim() || undefined,
      evidenceLinks: extractEvidenceLinks(titleCell ?? ''),
      tags: [],
    });
  }

  const evidence: LegacyEvidence[] = [];
  for (const row of parseTableRows(evidenceMd)) {
    const [numCell, titleCell, conclusionCell] = row.cells;
    const number = extractNumber(numCell ?? '');
    if (!number) continue;
    evidence.push({
      number,
      title: extractTitle(titleCell ?? '') || `(无标题 ${number})`,
      conclusion: (conclusionCell ?? '').trim() || undefined,
    });
  }

  return { tasks, evidence };
}
