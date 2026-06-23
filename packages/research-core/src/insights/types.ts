import type { NodeType } from '../schema';

/** 单条"该关注的事"。 */
export interface NextItem {
  kind: 'open-task' | 'tension' | 'stale' | 'orphan' | 'stagnant-thread';
  id: string;
  title: string;
  reason: string;
  related?: string[];
  age?: number; // 距 updatedAt 的天数
}

/** affected-by 闭包结果。 */
export interface AffectedReport {
  from: string;
  downstream: { id: string; path: string[] }[];
}

/** 全图统计。 */
export interface GraphStats {
  byType: Record<NodeType, number>;
  byStatus: Record<string, number>;
  orphans: string[];
  dangling: string[];
  openTensions: number;
  stagnantThreads: string[];
  totals: { nodes: number; edges: number; containsTrees: number };
}

/** 富 brief 的一行(纯数据,渲染由 renderBriefRich)。 */
export interface RichBriefLine {
  id: string;
  depth: number;
  statusTag: string;
  title: string;
  rollup?: string;
}

/** 默认陈旧阈值:14 天(两周)。 */
export const DEFAULT_STALE_DAYS = 14;
