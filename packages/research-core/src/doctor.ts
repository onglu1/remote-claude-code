import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_DIRS, REQUIRED_FILES } from './layout';
import { ResearchNodeSchema, NodeTypeSchema, type ResearchNode } from './schema';
import { typeToDir } from './nodeId';

export interface DoctorReport {
  ok: boolean;
  missingDirs: string[];
  missingFiles: string[];
  invalidNodes: string[];
  danglingRefs: string[];
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function scanNodes(root: string): { ids: Set<string>; invalid: string[]; valid: ResearchNode[] } {
  const ids = new Set<string>();
  const invalid: string[] = [];
  const valid: ResearchNode[] = [];
  for (const type of NodeTypeSchema.options) {
    const dir = path.join(root, 'research', 'nodes', typeToDir(type));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const rel = `research/nodes/${typeToDir(type)}/${f}`;
      try {
        const n = ResearchNodeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        ids.add(n.id);
        valid.push(n);
      } catch {
        invalid.push(rel);
      }
    }
  }
  return { ids, invalid, valid };
}

/** 校验目录/文件规范 + 节点 schema 合法性 + 边/父引用完整性。 */
export function checkResearchRepo(root: string): DoctorReport {
  const missingDirs = REQUIRED_DIRS.filter((d) => !isDir(path.join(root, d)));
  const missingFiles = REQUIRED_FILES.filter((f) => !isFile(path.join(root, f)));
  const { ids, invalid, valid } = scanNodes(root);
  const dangling: string[] = [];
  for (const n of valid) {
    if (n.parent && !ids.has(n.parent)) dangling.push(`${n.id} → ${n.parent}`);
    for (const e of n.edges) if (!ids.has(e.to)) dangling.push(`${n.id} → ${e.to}`);
  }
  const ok =
    missingDirs.length === 0 && missingFiles.length === 0 && invalid.length === 0 && dangling.length === 0;
  return { ok, missingDirs, missingFiles, invalidNodes: invalid, danglingRefs: dangling };
}
