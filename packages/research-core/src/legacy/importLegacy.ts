import type { NodeStore } from '../store';
import { addNode } from '../verbs/create';
import { linkNodes } from '../verbs/structure';
import type { ParsedLegacy, LegacyTask } from './parseLegacy';

export interface ImportReport {
  createdTasks: string[];      // 新建 task id 列表
  createdEvidence: string[];   // 新建 evidence id 列表
  skipped: string[];           // 已存在跳过的 id 列表
  linksAdded: number;          // 新建 produces 边数
  warnings: string[];
}

const STATUS_MAP: Record<LegacyTask['status'], string> = {
  todo: 'todo', doing: 'active', done: 'done', dropped: 'dropped',
};

/** 把 parsed 旧数据写入 research/(经写动词,不绕 schema)。已存在 id 跳过。 */
export function importLegacy(root: string, store: NodeStore, parsed: ParsedLegacy): ImportReport {
  const report: ImportReport = {
    createdTasks: [], createdEvidence: [], skipped: [], linksAdded: 0, warnings: [],
  };
  const now = new Date().toISOString();

  // 1. 先建 evidence(让 task 可以指向)
  for (const ev of parsed.evidence) {
    const id = `evidence/${ev.number}`;
    if (store.exists(id)) { report.skipped.push(id); continue; }
    try {
      addNode(root, store, {
        type: 'evidence',
        title: ev.title,
        as: ev.number,
        summary: ev.conclusion,
        result: 'inconclusive',
        now,
      });
      report.createdEvidence.push(id);
    } catch (e) {
      report.warnings.push(`evidence/${ev.number}: ${(e as Error).message}`);
    }
  }

  // 2. 建 task
  for (const t of parsed.tasks) {
    const id = `task/${t.number}`;
    if (store.exists(id)) { report.skipped.push(id); continue; }
    const summary = t.source ? `来源: ${t.source}` : undefined;
    try {
      const node = addNode(root, store, {
        type: 'task',
        title: t.title,
        as: t.number,
        summary,
        status: STATUS_MAP[t.status],
        now,
      });
      report.createdTasks.push(node.id);
    } catch (e) {
      report.warnings.push(`task/${t.number}: ${(e as Error).message}`);
    }
  }

  // 3. 连 produces 边(task → evidence)。只对**这次新建的 task** 加边(避免重复)。
  const createdTaskNumbers = new Set(parsed.tasks.map((t) => t.number).filter((n) => report.createdTasks.includes(`task/${n}`)));
  for (const t of parsed.tasks) {
    if (!createdTaskNumbers.has(t.number)) continue;
    for (const evNum of t.evidenceLinks) {
      const evId = `evidence/${evNum}`;
      if (!store.exists(evId)) { report.warnings.push(`task/${t.number} → ${evId} 不存在,跳过 produces 边`); continue; }
      try {
        linkNodes(store, { from: `task/${t.number}`, to: evId, label: 'produces', now });
        report.linksAdded++;
      } catch (e) {
        report.warnings.push(`link task/${t.number}→${evId}: ${(e as Error).message}`);
      }
    }
  }

  return report;
}
