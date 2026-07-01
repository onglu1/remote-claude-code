import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { type Conversation, type AgentKind } from '@rcc/shared';
import { Tmux } from './session/tmux';

type StoredConversation = Omit<Conversation, 'alive'>;
const CONVERSATION_ID_BYTES = 12;

function newConversationId(existing: StoredConversation[]): string {
  let id = '';
  do {
    id = crypto.randomBytes(CONVERSATION_ID_BYTES).toString('hex');
  } while (existing.some((c) => c.id === id));
  return id;
}

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
    // agentKind/codexSessionDiscovered 是 codex 支持新增的字段，老 conversations.json 没有
    // → 回填默认(沿用 sessionId/effort 的防御性补全模式，零数据迁移脚本)。
    return this.loadRaw().map((c) => ({
      ...(c as StoredConversation),
      sessionId: c.sessionId ?? crypto.randomUUID(),
      effort: c.effort ?? 'max',
      agentKind: c.agentKind ?? 'claude',
      codexSessionDiscovered: c.codexSessionDiscovered ?? false,
    }));
  }

  /**
   * 一次性迁移：给老数据补缺失字段:
   *  - sessionId 缺 → 随机 UUID(旧版会话无 sessionId)
   *  - starred undefined → false
   *  - lastActivityAt 缺且有 createdAt → 用 createdAt 兜底
   */
  migrate(): void {
    const list = this.loadRaw();
    let changed = false;
    const next = list.map((c) => {
      const patch: Partial<StoredConversation> = { ...c };
      if (!patch.sessionId) {
        changed = true;
        patch.sessionId = crypto.randomUUID();
      }
      if (patch.starred === undefined) {
        changed = true;
        patch.starred = false;
      }
      if (!patch.lastActivityAt && patch.createdAt) {
        changed = true;
        patch.lastActivityAt = patch.createdAt;
      }
      return patch;
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

  /** 所有非软删除且未休眠的会话(扁平,所有项目所有用户)。供 IdleSweeper 用。 */
  listAllAlive(): StoredConversation[] {
    return this.loadAll().filter((c) => !c.deletedAt && !c.closedAt);
  }

  /** 所有会话(含软删除)。仅用于需要全局排重/排除已知 sessionId 的内部流程。 */
  listAll(): StoredConversation[] {
    return this.loadAll();
  }

  /** 按 id 取(无论是否软删除;调用方按需要看 deletedAt 字段)。 */
  get(convId: string): StoredConversation | undefined {
    return this.loadAll().find((c) => c.id === convId);
  }

  /** 按项目 + id 取;会话路由必须走这个入口,避免跨项目同 id 串台。 */
  getInProject(projectId: string, convId: string): StoredConversation | undefined {
    return this.loadAll().find((c) => c.projectId === projectId && c.id === convId);
  }

  /**
   * 新建会话。
   * @param sessionId 可选:指定一个已存在的 claude session UUID,新会话会以 --resume 接续那段 transcript。
   *                  缺省时随机生成新 UUID(首次启动用 --session-id)。
   * @param opts 可选:agent 选择与会话级 launchCommand。
   *             agentKind 缺省 'claude';launchCommand 缺省 undefined(走 adapter 默认);
   *             codexSessionDiscovered 缺省 false(codex 路径下首次启动后扫到再回写)——
   *             用户显式传入续接的真实 codex UUID 时,路由层可置 true 跳过扫描。
   */
  create(
    projectId: string,
    name: string,
    sessionId?: string,
    opts?: { agentKind?: AgentKind; launchCommand?: string; codexSessionDiscovered?: boolean },
  ): StoredConversation {
    const all = this.loadAll();
    const id = newConversationId(all);
    const conv: StoredConversation = {
      id,
      projectId,
      name: name || `会话 ${all.filter((c) => c.projectId === projectId && !c.deletedAt).length + 1}`,
      tmuxName: Tmux.sessionName(projectId, id),
      // 所有会话都分配 claude 会话 UUID：用 --session-id 启动，两种视图通用。
      sessionId: sessionId || crypto.randomUUID(),
      // 聊天默认思考强度 max（可在聊天里切换并持久化）。
      effort: 'max',
      // 标星默认 false;迁移逻辑也补这个字段,但新建路径要显式写,否则 schema 推断会要求必填。
      starred: false,
      // agent 选择:缺省 claude(原生路径行为零变化);codex 走第 4 参数显式传入。
      agentKind: opts?.agentKind ?? 'claude',
      // 会话级 launchCommand:留空 = 走 adapter 默认(claude 用 Project.launchCommand;codex 用全局常量)。
      launchCommand: opts?.launchCommand,
      // codex 会话 UUID 首次发现后才回写为 true;claude 恒为 false(用不上)。
      // 用户显式传入续接的 codex UUID 时,opts.codexSessionDiscovered=true 只记录来源;
      // 是否 resume 仍由 adapter 在当前 cwd 下定位 transcript 决定。
      codexSessionDiscovered: opts?.codexSessionDiscovered ?? false,
      createdAt: new Date().toISOString(),
      // lastActivityAt 与 createdAt 相同,便于前端按"最近活跃"排序时新会话也有值。
      lastActivityAt: new Date().toISOString(),
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

  /** 项目内局部更新;路由层使用,避免重复 id 时改到别的项目。 */
  updateInProject(
    projectId: string,
    convId: string,
    patch: Partial<StoredConversation>,
  ): StoredConversation | undefined {
    const all = this.loadAll();
    const i = all.findIndex((c) => c.projectId === projectId && c.id === convId);
    if (i === -1) return undefined;
    all[i] = { ...all[i], ...patch, id: all[i].id, projectId: all[i].projectId };
    this.write(all);
    return all[i];
  }

  /** 仅更新 lastActivityAt;比 update 路径轻,活动探测器高频调用专用。 */
  markActivity(convId: string, ts: string): StoredConversation | undefined {
    return this.update(convId, { lastActivityAt: ts });
  }

  markActivityInProject(projectId: string, convId: string, ts: string): StoredConversation | undefined {
    return this.updateInProject(projectId, convId, { lastActivityAt: ts });
  }

  /** 会话被用户重新进入/显式恢复:清休眠标记并刷新活动时间。 */
  markActive(convId: string, ts: string): StoredConversation | undefined {
    return this.update(convId, { closedAt: undefined, lastActivityAt: ts });
  }

  markActiveInProject(projectId: string, convId: string, ts: string): StoredConversation | undefined {
    return this.updateInProject(projectId, convId, { closedAt: undefined, lastActivityAt: ts });
  }

  /** 软删除:打 deletedAt 戳,不真的删 metadata,可恢复。 */
  softDelete(convId: string): StoredConversation | undefined {
    return this.update(convId, { deletedAt: new Date().toISOString() });
  }

  softDeleteInProject(projectId: string, convId: string): StoredConversation | undefined {
    return this.updateInProject(projectId, convId, { deletedAt: new Date().toISOString() });
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

  restoreInProject(projectId: string, convId: string): StoredConversation | undefined {
    const all = this.loadAll();
    const i = all.findIndex((c) => c.projectId === projectId && c.id === convId);
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

  hardDeleteInProject(projectId: string, convId: string): void {
    this.write(this.loadAll().filter((c) => !(c.projectId === projectId && c.id === convId)));
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
