import { NodeTypeSchema, type NodeType } from './schema';

const TYPE_DIR: Record<NodeType, string> = {
  thread: 'threads',
  idea: 'ideas',
  task: 'tasks',
  evidence: 'evidence',
  reference: 'references',
};
const DIR_TYPE: Record<string, NodeType> = Object.fromEntries(
  Object.entries(TYPE_DIR).map(([t, d]) => [d, t as NodeType]),
);

export function typeToDir(type: NodeType): string {
  return TYPE_DIR[type];
}

export function dirToType(dir: string): NodeType | undefined {
  return DIR_TYPE[dir];
}

/** "task/007" → { type, number };校验 type 合法、编号非空。 */
export function parseId(id: string): { type: NodeType; number: string } {
  const slash = id.indexOf('/');
  if (slash < 0) throw new Error(`非法 id(缺 "/"): ${id}`);
  const type = NodeTypeSchema.parse(id.slice(0, slash));
  const number = id.slice(slash + 1);
  if (!isValidNumber(number)) throw new Error(`非法 id(编号非法): ${id}`);
  return { type, number };
}

/** id → 相对仓库根的 JSON 路径。 */
export function idToPath(id: string): string {
  const { type, number } = parseId(id);
  return `research/nodes/${typeToDir(type)}/${number}.json`;
}

/** 主编号 NNN / 子编号 NNN.M / reference 的 citekey:非空、无斜杠与空白。 */
export function isValidNumber(number: string): boolean {
  return number.length > 0 && !/[\s/]/.test(number);
}
