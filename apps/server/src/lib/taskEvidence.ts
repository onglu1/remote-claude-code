import fs from 'node:fs';
import path from 'node:path';
import { type TaskItem, type EvidenceItem, type TaskStatus } from '@rcc/shared';

interface SidecarMeta {
  tasks: Record<string, { status?: TaskStatus; evidenceLinks?: string[]; tags?: string[] }>;
}

/**
 * 解析项目 docs/ 下的 tasks 与 evidence。
 * - 解析 INDEX.md 表格 + 链接，推断默认状态/标题/关联。
 * - 网页侧的编辑（状态/链接/标签）写入 docs/.rcc-meta.json 侧车文件，
 *   不改动手写的 INDEX / 正文，彻底规避破坏风险。
 */
export class TaskEvidenceStore {
  private readonly tasksIndex: string;
  private readonly evidenceIndex: string;
  private readonly sidecar: string;

  constructor(private readonly docsDir: string) {
    this.tasksIndex = path.join(docsDir, 'tasks', 'INDEX.md');
    this.evidenceIndex = path.join(docsDir, 'evidence', 'INDEX.md');
    this.sidecar = path.join(docsDir, '.rcc-meta.json');
  }

  hasDocs(): boolean {
    return fs.existsSync(this.tasksIndex) || fs.existsSync(this.evidenceIndex);
  }

  getTasks(): TaskItem[] {
    const meta = this.readSidecar();
    const base = parseTableRows(readSafe(this.tasksIndex)).map((row) => rowToTask(row));
    return base.map((t) => {
      const m = meta.tasks[t.number];
      return {
        ...t,
        status: m?.status ?? t.status,
        evidenceLinks: m?.evidenceLinks ?? t.evidenceLinks,
        tags: m?.tags ?? t.tags,
      };
    });
  }

  getEvidence(): EvidenceItem[] {
    const evidence = parseTableRows(readSafe(this.evidenceIndex)).map((row) => rowToEvidence(row));
    // 反向链接：从 tasks 的 evidenceLinks 推导每条 evidence 关联的 task
    const tasks = this.getTasks();
    const reverse = new Map<string, string[]>();
    for (const t of tasks) {
      for (const e of t.evidenceLinks) {
        reverse.set(e, [...(reverse.get(e) ?? []), t.number]);
      }
    }
    return evidence.map((e) => ({ ...e, taskLinks: reverse.get(e.number) ?? [] }));
  }

  patchTask(
    number: string,
    patch: { status?: TaskStatus; evidenceLinks?: string[]; tags?: string[] },
  ): void {
    const meta = this.readSidecar();
    meta.tasks[number] = { ...meta.tasks[number], ...patch };
    this.writeSidecar(meta);
  }

  private readSidecar(): SidecarMeta {
    if (!fs.existsSync(this.sidecar)) return { tasks: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sidecar, 'utf8')) as SidecarMeta;
      return { tasks: parsed.tasks ?? {} };
    } catch {
      return { tasks: {} };
    }
  }

  private writeSidecar(meta: SidecarMeta): void {
    fs.mkdirSync(this.docsDir, { recursive: true });
    if (fs.existsSync(this.sidecar)) fs.copyFileSync(this.sidecar, `${this.sidecar}.bak`);
    const tmp = `${this.sidecar}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n');
    fs.renameSync(tmp, this.sidecar);
  }
}

function readSafe(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

interface TableRow {
  cells: string[];
}

/** 解析 markdown 表格的内容行（跳过表头与分隔行）。 */
export function parseTableRows(md: string): TableRow[] {
  const rows: TableRow[] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|?$/.test(t)) continue; // 分隔行 |---|---|
    const cells = t
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length === 0) continue;
    if (/编号/.test(cells[0])) continue; // 表头
    if (!/\d/.test(cells[0])) continue; // 第一列必须含数字编号
    rows.push({ cells });
  }
  return rows;
}

function firstLink(cell: string): { text: string; target: string } | null {
  const m = /\[([^\]]+)\]\(([^)]+)\)/.exec(cell);
  return m ? { text: m[1], target: m[2] } : null;
}

function extractNumber(cell: string): string {
  const m = /(\d+[\d.]*[a-z]?)/.exec(cell);
  return m ? m[1] : cell.replace(/[^0-9.]/g, '');
}

function inferStatus(cell: string): TaskStatus {
  if (/废弃|drop/i.test(cell)) return 'dropped';
  if (/~~|已完成|完成|done/i.test(cell)) return 'done';
  if (/进行中|doing|wip/i.test(cell)) return 'doing';
  return 'todo';
}

function extractEvidenceLinks(cell: string): string[] {
  const out = new Set<string>();
  const re = /evidence[ /](\d+[\d.]*[a-z]?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell))) out.add(m[1]);
  return [...out];
}

function rowToTask(row: TableRow): TaskItem {
  const { cells } = row;
  const number = extractNumber(cells[0]);
  const link = firstLink(cells[1] ?? '');
  const title = (link?.text ?? cells[1] ?? '').replace(/~~/g, '').trim();
  return {
    number,
    title,
    file: link?.target ?? '',
    status: inferStatus(cells[1] ?? ''),
    priority: cells[2]?.replace(/~~/g, '').trim() || undefined,
    source: cells[3]?.trim() || undefined,
    evidenceLinks: extractEvidenceLinks(cells[1] ?? ''),
    tags: [],
  };
}

function rowToEvidence(row: TableRow): EvidenceItem {
  const { cells } = row;
  const number = extractNumber(cells[0]);
  const link = firstLink(cells[1] ?? '');
  const title = (link?.text ?? cells[1] ?? '').replace(/~~/g, '').trim();
  return {
    number,
    title,
    file: link?.target ?? '',
    conclusion: cells[2]?.trim() || undefined,
    taskLinks: [],
  };
}
