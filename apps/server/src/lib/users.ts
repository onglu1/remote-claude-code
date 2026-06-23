import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserSchema, type User, type Role } from '@rcc/shared';

export interface UserCreate {
  username: string;
  passwordHash: string;
  role: Role;
}

/**
 * 用户存储：唯一来源是一个 JSON 文件（显式登记，零扫描）。
 * 照搬 ProjectStore 风格：原子写（tmp→rename）+ 写前 .bak。
 * 仅存数据/IO，不做 argon2（哈希在 context/路由层算好再传入），便于纯单测。
 */
export class UserStore {
  constructor(private readonly file: string) {}

  load(): User[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((x) => UserSchema.parse(x));
  }

  count(): number {
    return this.load().length;
  }

  get(id: string): User | undefined {
    return this.load().find((u) => u.id === id);
  }

  findByUsername(username: string): User | undefined {
    return this.load().find((u) => u.username === username);
  }

  add(input: UserCreate): User {
    const users = this.load();
    if (users.some((u) => u.username === input.username)) {
      throw new Error(`用户名已存在: ${input.username}`);
    }
    const user: User = UserSchema.parse({
      id: crypto.randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      createdAt: new Date().toISOString(),
    });
    this.write([...users, user]);
    return user;
  }

  setPassword(id: string, passwordHash: string): User | undefined {
    const users = this.load();
    const i = users.findIndex((u) => u.id === id);
    if (i === -1) return undefined;
    users[i] = { ...users[i], passwordHash };
    this.write(users);
    return users[i];
  }

  remove(id: string): void {
    this.write(this.load().filter((u) => u.id !== id));
  }

  /** 原子写：写临时文件再 rename；写前备份为 .bak。 */
  private write(users: User[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, `${this.file}.bak`);
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
