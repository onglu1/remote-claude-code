/**
 * 科研图派生类型 — 全部 re-export 自 @rcc/research-core(barrel)。
 * 共用同一份 schema/insights,前后端永不分叉。
 *
 * 命名说明:research-core 的 `TaskStatus` 与 shared/src/schemas.ts 中
 * 老 task/evidence 模块的 `TaskStatus`(值 todo/doing/done/dropped)同名不同义,
 * 故在此用别名 `ResearchTaskStatus` 暴露,避免 barrel 命名冲突。
 * 需要原名时直接从 @rcc/research-core 引入。
 */
export type {
  ResearchNode, ThreadNode, IdeaNode, TaskNode, EvidenceNode, ReferenceNode,
  NodeType, Edge, Lifecycle,
  ThreadStatus, IdeaStatus, EvidenceStatus, EvidenceResult,
  TaskStatus as ResearchTaskStatus,
  NextItem, AffectedReport, GraphStats, RichBriefLine,
} from '@rcc/research-core';
