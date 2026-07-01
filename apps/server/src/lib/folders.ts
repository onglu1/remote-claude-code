import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FolderSchema, type Folder } from '@rcc/shared';
import type { ConversationStore } from './conversations';

function newFolderId(existing: Folder[]): string {
  let id = '';
  do {
    id = `fld_${crypto.randomBytes(6).toString('hex')}`;
  } while (existing.some((f) => f.id === id));
  return id;
}

/**
 * 文件夹存储:JSON 平铺,按 (projectId, ownerId) 隔离;
 * remove 时把内部会话的 folderId 置 null,保证不出现悬空引用。
 * 与 ConversationStore 同风格:原子 tmp+rename + .bak。
 */
export class FolderStore {
  constructor(
    private readonly file: string,
    private readonly conversations: ConversationStore,
  ) {}

  private loadAll(): Folder[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((x) => FolderSchema.parse(x));
  }

  /** 本项目本用户的文件夹,按 sortOrder 升序,同序按 createdAt 升序。 */
  listByProject(projectId: string, ownerId: string): Folder[] {
    return this.loadAll()
      .filter((f) => f.projectId === projectId && f.ownerId === ownerId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Folder | undefined {
    return this.loadAll().find((f) => f.id === id);
  }

  create(projectId: string, ownerId: string, name: string): Folder {
    const trimmed = name.trim();
    const all = this.loadAll();
    if (all.some((f) => f.projectId === projectId && f.ownerId === ownerId && f.name === trimmed)) {
      throw new Error(`duplicate folder name: ${trimmed}`);
    }
    const folder: Folder = FolderSchema.parse({
      id: newFolderId(all),
      projectId,
      ownerId,
      name: trimmed,
      sortOrder: all.filter((f) => f.projectId === projectId && f.ownerId === ownerId).length,
      createdAt: new Date().toISOString(),
    });
    this.write([...all, folder]);
    return folder;
  }

  rename(id: string, name: string): Folder | undefined {
    const all = this.loadAll();
    const i = all.findIndex((f) => f.id === id);
    if (i === -1) return undefined;
    const trimmed = name.trim();
    if (all.some((f) => f.id !== id && f.projectId === all[i].projectId && f.ownerId === all[i].ownerId && f.name === trimmed)) {
      throw new Error(`duplicate folder name: ${trimmed}`);
    }
    all[i] = { ...all[i], name: trimmed };
    this.write(all);
    return all[i];
  }

  reorder(orderedIds: string[]): void {
    const all = this.loadAll();
    const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
    const next = all.map((f) =>
      indexMap.has(f.id) ? { ...f, sortOrder: indexMap.get(f.id)! } : f,
    );
    this.write(next);
  }

  /**
   * 删除文件夹;内部会话 folderId 置 null。返回被重排的会话数。
   * 必须连垃圾箱(已软删除)里的会话一起扫——listByProject 只看「活动」会话,
   * 漏了软删除的话,这些会话的 folderId 会变成指向已不存在文件夹的悬空引用,
   * 恢复出来后前端按 folderId 分组会找不到对应文件夹。
   */
  remove(id: string): { reassigned: number } {
    const all = this.loadAll();
    const target = all.find((f) => f.id === id);
    if (!target) return { reassigned: 0 };
    const affected = this.conversations
      .listAll()
      .filter((c) => c.projectId === target.projectId && c.folderId === id);
    for (const c of affected) {
      this.conversations.updateInProject(c.projectId, c.id, { folderId: null });
    }
    this.write(all.filter((f) => f.id !== id));
    return { reassigned: affected.length };
  }

  private write(list: Folder[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
