import fs from 'node:fs';
import path from 'node:path';
import { ResearchNodeSchema, NodeTypeSchema, type ResearchNode, type NodeType } from './schema';
import { idToPath, typeToDir } from './nodeId';

/** 单节点 JSON 的读 / 写 / 列举。纯 IO,不懂语义。schema 校验在读写两端都做。 */
export class NodeStore {
  constructor(private readonly root: string) {}

  private abs(id: string): string {
    return path.join(this.root, idToPath(id));
  }

  exists(id: string): boolean {
    return fs.existsSync(this.abs(id));
  }

  /** 读 + schema 校验;不存在或非法即 throw。 */
  read(id: string): ResearchNode {
    const file = this.abs(id);
    if (!fs.existsSync(file)) throw new Error(`节点不存在: ${id}`);
    return ResearchNodeSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  tryRead(id: string): ResearchNode | null {
    return this.exists(id) ? this.read(id) : null;
  }

  /** schema 校验 → 原子写(.bak + tmp + rename)。 */
  write(node: ResearchNode): void {
    const valid = ResearchNodeSchema.parse(node);
    const file = this.abs(valid.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  listByType(type: NodeType): ResearchNode[] {
    const dir = path.join(this.root, 'research', 'nodes', typeToDir(type));
    if (!fs.existsSync(dir)) return [];
    const out: ResearchNode[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      out.push(ResearchNodeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
    }
    return out;
  }

  list(): ResearchNode[] {
    return NodeTypeSchema.options.flatMap((t) => this.listByType(t));
  }
}
