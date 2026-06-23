import fs from 'node:fs';
import path from 'node:path';
import { type ResearchNode } from './schema';
import { NodeStore } from './store';

/** 派生缓存:全量节点快照(可重建、非第二真值)。 */
export interface IndexData {
  builtAt: string;
  nodes: ResearchNode[];
}

export function indexPath(root: string): string {
  return path.join(root, 'research', '.index', 'graph.json');
}

/** 从 store 全量快照重建 .index/graph.json(原子写),返回写入的数据。 */
export function rebuildIndex(root: string, store: NodeStore, now?: string): IndexData {
  const data: IndexData = { builtAt: now ?? new Date().toISOString(), nodes: store.list() };
  const file = indexPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return data;
}

/** 读 .index/graph.json;缺失返回 null(调用方回退现场构建)。 */
export function readIndex(root: string): IndexData | null {
  const file = indexPath(root);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as IndexData;
}
