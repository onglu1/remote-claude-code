import fs from 'node:fs';
import path from 'node:path';
import { type NodeType } from './schema';
import { typeToDir } from './nodeId';

/** 扫该类型目录,返回下一个主编号(零填充 3 位)。reference 用 citekey,不走此函数。 */
export function nextNumber(root: string, type: NodeType): string {
  const dir = path.join(root, 'research', 'nodes', typeToDir(type));
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)(?:\.\d+)?\.json$/.exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return String(max + 1).padStart(3, '0');
}
