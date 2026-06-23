import { z } from 'zod';

/** 节点类型:核心实验链 + 外围 reference。 */
export const NodeTypeSchema = z.enum(['thread', 'idea', 'task', 'evidence', 'reference']);
export type NodeType = z.infer<typeof NodeTypeSchema>;

/** 各类型生命周期 status。 */
export const ThreadStatusSchema = z.enum(['open', 'parked', 'concluded']);
export const IdeaStatusSchema = z.enum(['incubating', 'parked', 'crystallized', 'dropped']);
export const TaskStatusSchema = z.enum([
  'todo', 'active', 'done', 'superseded', 'invalidated', 'dropped', 'blocked',
]);
export const EvidenceStatusSchema = z.enum(['active', 'superseded', 'invalidated']);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type IdeaStatus = z.infer<typeof IdeaStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

/** evidence 结果极性:负结果一等公民;mixed = 某条件成立另一条件不成立。 */
export const EvidenceResultSchema = z.enum(['positive', 'negative', 'inconclusive', 'mixed']);
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

/** 边:自由语义边 {to,label,note};contradicts 额外用 state。 */
export const EdgeSchema = z.object({
  to: z.string().min(1),
  label: z.string().min(1),
  note: z.string().optional(),
  state: z.enum(['open', 'resolved']).optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

/** 生命周期后继指针(由动词写入,非边)。 */
export const LifecycleSchema = z.object({
  supersededBy: z.string().optional(),
  supersedes: z.string().optional(),
  supersededReason: z.string().optional(),
  invalidatedReason: z.string().optional(),
  droppedReason: z.string().optional(),
  blockedOn: z.array(z.string()).optional(),
  at: z.string().optional(),
});
export type Lifecycle = z.infer<typeof LifecycleSchema>;

/** 节点 title 最大字符数(非 reference)。用于约束 CLI/AI 写出可视化友好的短标题。 */
export const TITLE_MAX_LEN = 80;
/** reference 节点 title 最大字符数(论文标题往往更长,放宽到 120)。 */
export const REFERENCE_TITLE_MAX_LEN = 120;

/** 所有节点公共字段。 */
const baseShape = {
  id: z.string().min(1),
  title: z.string().min(1).max(TITLE_MAX_LEN, {
    message: `标题不能超过 ${TITLE_MAX_LEN} 字符(为网络图可视化友好,请精简)`,
  }),
  summary: z.string().optional(),
  parent: z.string().optional(),
  edges: z.array(EdgeSchema).default([]),
  aliases: z.array(z.string()).default([]),
  kind: z.array(z.string()).default([]),
  text: z.string().optional(),
  lifecycle: LifecycleSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const ThreadNodeSchema = z.object({
  ...baseShape, type: z.literal('thread'), status: ThreadStatusSchema,
});
export const IdeaNodeSchema = z.object({
  ...baseShape, type: z.literal('idea'), status: IdeaStatusSchema,
});
export const TaskNodeSchema = z.object({
  ...baseShape,
  type: z.literal('task'),
  status: TaskStatusSchema,
  expectation: z.string().optional(),
  code: z.array(z.string()).default([]),
});
export const EvidenceNodeSchema = z.object({
  ...baseShape,
  type: z.literal('evidence'),
  status: EvidenceStatusSchema,
  result: EvidenceResultSchema,
  output: z.array(z.string()).default([]),
  manifest: z.string().optional(),
});
export const ReferenceNodeSchema = z.object({
  ...baseShape,
  // reference 论文标题往往更长,放宽到 120 字符
  title: z.string().min(1).max(REFERENCE_TITLE_MAX_LEN, {
    message: `reference 标题不能超过 ${REFERENCE_TITLE_MAX_LEN} 字符`,
  }),
  type: z.literal('reference'),
  url: z.string().optional(),
  citekey: z.string().optional(),
});

/** 节点真值类型:判别联合,按 type 收紧。 */
export const ResearchNodeSchema = z.discriminatedUnion('type', [
  ThreadNodeSchema, IdeaNodeSchema, TaskNodeSchema, EvidenceNodeSchema, ReferenceNodeSchema,
]);
export type ResearchNode = z.infer<typeof ResearchNodeSchema>;
export type ThreadNode = z.infer<typeof ThreadNodeSchema>;
export type IdeaNode = z.infer<typeof IdeaNodeSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type EvidenceNode = z.infer<typeof EvidenceNodeSchema>;
export type ReferenceNode = z.infer<typeof ReferenceNodeSchema>;
