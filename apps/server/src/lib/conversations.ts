import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { type Conversation } from '@rcc/shared';
import { Tmux } from './session/tmux';

type StoredConversation = Omit<Conversation, 'alive'>;

/**
 * 会话元数据存储（id/name/tmuxName/sessionId/createdAt/deletedAt）。
 * 存活态由 tmux 实时给出;deletedAt 在则表示软删除(垃圾箱),常规列表过滤掉,可恢复或彻底删。
 */
export class ConversationStore {
  constructor(private readonly file: string) {}

  private loadRaw(): Array<Partial<StoredConversation>> {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    return JSON.parse(raw) as Array<Partial<StoredConversation>>;
  }

  private loadAll(): StoredConversation[] {
    // 防御性补全：正常情况下 migrate() 已确保每条都有 sessionId；旧记录补 effort 默认。
    return this.loadRaw().map((c) => ({
      ...(c as StoredConversation),
      sessionId: c.sessionId ?? crypto.randomUUID(),
      effort: c.effort ?? 'max',
    }));
  }

  /** 一次性迁移：给缺 sessionId 的存量记录补一个并落盘（旧版会话无 sessionId）。 */
  migrate(): void {
    const list = this.loadRaw();
    let changed = false;
    const next = list.map((c) => {
      if (!c.sessionId) {
        changed = true;
        return { ...c, sessionId: crypto.randomUUID() };
      }
      return c;
    });
    if (changed) this.write(next as StoredConversation[]);
  }

  /** 项目下的「活动」会话(不含垃圾箱)。 */
  listByProject(projectId: string): StoredConversation[] {
    return this.loadAll().filter((c) => c.projectId === projectId && !c.deletedAt);
  }

  /** 项目下的「垃圾箱」会话(已软删除,可恢复)。 */
  listDeletedByProject(projectId: string): StoredConversation[] {
    return this.loadAll().filter((c) => c.projectId === projectId && c.deletedAt);
  }

  /** 按 id 取(无论是否软删除;调用方按需要看 deletedAt 字段)。 */
  get(convId: string): StoredConversation | undefined {
    return this.loadAll().find((c) => c.id === convId);
  }

  /**
   * 新建会话。
   * @param sessionId 可选:指定一个已存在的 claude session UUID,新会话会以 --resume 接续那段 transcript。
   *                  缺省时随机生成新 UUID(首次启动用 --session-id)。
   */
  create(projectId: string, name: string, sessionId?: string): StoredConversation {
    const all = this.loadAll();
    const id = crypto.randomBytes(4).toString('hex');
    const conv: StoredConversation = {
      id,
      projectId,
      name: name || `会话 ${all.filter((c) => c.projectId === projectId && !c.deletedAt).length + 1}`,
      tmuxName: Tmux.sessionName(projectId, id),
      // 所有会话都分配 claude 会话 UUID：用 --session-id 启动，两种视图通用。
      sessionId: sessionId || crypto.randomUUID(),
      // 聊天默认思考强度 max（可在聊天里切换并持久化）。
      effort: 'max',
      createdAt: new Date().toISOString(),
    };
    this.write([...all, conv]);
    return conv;
  }

  /** 局部更新（如切换 effort）；id 不可改。会话不存在返回 undefined。 */
  update(convId: string, patch: Partial<StoredConversation>): StoredConversation | undefined {
    const all = this.loadAll();
    const i = all.findIndex((c) => c.id === convId);
    if (i === -1) return undefined;
    all[i] = { ...all[i], ...patch, id: all[i].id };
    this.write(all);
    return all[i];
  }

  /** 软删除:打 deletedAt 戳,不真的删 metadata,可恢复。 */
  softDelete(convId: string): StoredConversation | undefined {
    return this.update(convId, { deletedAt: new Date().toISOString() });
  }

  /** 恢复:清掉 deletedAt 戳。tmux 不主动重启,进入会话时 ensure 自然拉。 */
  restore(convId: string): StoredConversation | undefined {
    const all = this.loadAll();
    const i = all.findIndex((c) => c.id === convId);
    if (i === -1) return undefined;
    const next = { ...all[i] };
    delete next.deletedAt;
    all[i] = next;
    this.write(all);
    return next;
  }

  /** 彻底删除(垃圾箱清空动作);不可恢复。 */
  hardDelete(convId: string): void {
    this.write(this.loadAll().filter((c) => c.id !== convId));
  }

  /** 兼容旧调用方:同 hardDelete。 */
  remove(convId: string): void {
    this.hardDelete(convId);
  }

  private write(list: StoredConversation[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
