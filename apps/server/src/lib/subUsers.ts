import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SubUserSchema, type SubUser } from '@rcc/shared';
import type { UserStore } from './users';

export interface SubUserCreate {
  parentId: string;
  username: string;
  passwordHash: string;
  displayName: string;
}

/**
 * 子用户存储:与 UserStore 同风格(显式 JSON + 原子写 tmp→rename + .bak)。
 * 不做 argon2(哈希在 context/路由层算好再传入),便于纯单测。
 * username 在全局命名空间唯一:add() 既查自己也查注入的 UserStore。
 */
export class SubUserStore {
  // 双向引用在 context 构建时拼出来;构造时 users 可省略(单独测 SubUserStore 用)。
  // 用赋值而非 readonly 因为存在"先建 SubUserStore,后建 UserStore,再回填"的初始化序。
  public users?: UserStore;

  constructor(private readonly file: string, users?: UserStore) {
    this.users = users;
  }

  load(): SubUser[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((x) => SubUserSchema.parse(x));
  }

  count(): number {
    return this.load().length;
  }

  get(id: string): SubUser | undefined {
    return this.load().find((s) => s.id === id);
  }

  findByUsername(username: string): SubUser | undefined {
    return this.load().find((s) => s.username === username);
  }

  listByParent(parentId: string): SubUser[] {
    return this.load().filter((s) => s.parentId === parentId);
  }

  add(input: SubUserCreate): SubUser {
    const all = this.load();
    if (all.some((s) => s.username === input.username)) {
      throw new Error(`子用户名已存在: ${input.username}`);
    }
    if (this.users?.findByUsername(input.username)) {
      throw new Error(`用户名已存在(主账号): ${input.username}`);
    }
    const sub: SubUser = SubUserSchema.parse({
      id: crypto.randomUUID(),
      parentId: input.parentId,
      username: input.username,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      createdAt: new Date().toISOString(),
    });
    this.write([...all, sub]);
    return sub;
  }

  setPassword(id: string, passwordHash: string): SubUser | undefined {
    const all = this.load();
    const i = all.findIndex((s) => s.id === id);
    if (i === -1) return undefined;
    all[i] = { ...all[i], passwordHash };
    this.write(all);
    return all[i];
  }

  updateSettings(id: string, settings: { idleCloseHours: number }): SubUser | undefined {
    const all = this.load();
    const i = all.findIndex((s) => s.id === id);
    if (i === -1) return undefined;
    all[i] = { ...all[i], settings: { ...all[i].settings, ...settings } };
    this.write(all);
    return all[i];
  }

  rename(id: string, displayName: string): SubUser | undefined {
    const all = this.load();
    const i = all.findIndex((s) => s.id === id);
    if (i === -1) return undefined;
    all[i] = { ...all[i], displayName };
    this.write(all);
    return all[i];
  }

  remove(id: string): void {
    this.write(this.load().filter((s) => s.id !== id));
  }

  private write(subs: SubUser[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(subs, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
