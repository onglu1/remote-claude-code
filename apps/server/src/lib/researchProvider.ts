import fs from 'node:fs';
import path from 'node:path';
import { NodeStore, ResearchGraph } from '@rcc/research-core';

interface Cached {
  store: NodeStore;
  graph?: ResearchGraph;
}

/**
 * 每个 project.path 对应一个 NodeStore(惰性建,缓存到 process 生命周期)。
 * ResearchGraph 是全量节点的内存快照,写动词后用 invalidate 失效让下次重建。
 */
export class ResearchProviderRegistry {
  private readonly cache = new Map<string, Cached>();

  store(projectPath: string): NodeStore {
    let c = this.cache.get(projectPath);
    if (!c) {
      c = { store: new NodeStore(projectPath) };
      this.cache.set(projectPath, c);
    }
    return c.store;
  }

  graph(projectPath: string): ResearchGraph {
    const c = this.cache.get(projectPath) ?? { store: new NodeStore(projectPath) };
    if (!c.graph) c.graph = new ResearchGraph(c.store.list());
    this.cache.set(projectPath, c);
    return c.graph;
  }

  invalidate(projectPath: string): void {
    const c = this.cache.get(projectPath);
    if (c) c.graph = undefined;
  }

  /** 探测项目是否已 scaffold(看 research/nodes/threads 目录存在)。 */
  initialized(projectPath: string): boolean {
    try {
      return fs.statSync(path.join(projectPath, 'research', 'nodes', 'threads')).isDirectory();
    } catch {
      return false;
    }
  }
}
