import fs from 'node:fs';
import path from 'node:path';
import { ProjectSchema, type Project, type ProjectCreate } from '@rcc/shared';

/**
 * 项目注册表：唯一来源是一个 JSON 文件（显式登记）。
 * 绝不扫描/遍历任何目录来发现项目。
 */
export class ProjectStore {
  constructor(private readonly file: string) {}

  load(): Project[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((x) => ProjectSchema.parse(x));
  }

  get(id: string): Project | undefined {
    return this.load().find((p) => p.id === id);
  }

  add(input: ProjectCreate): Project {
    const projects = this.load();
    const id = input.id ?? slugify(input.name);
    if (!path.isAbsolute(input.path)) {
      throw new Error('项目路径必须是绝对路径');
    }
    if (!fs.existsSync(input.path) || !fs.statSync(input.path).isDirectory()) {
      throw new Error(`路径不存在或不是目录: ${input.path}`);
    }
    if (projects.some((p) => p.id === id)) {
      throw new Error(`项目 id 已存在: ${id}`);
    }
    const project = ProjectSchema.parse({ ...input, id });
    this.write([...projects, project]);
    return project;
  }

  remove(id: string): void {
    const projects = this.load();
    this.write(projects.filter((p) => p.id !== id));
  }

  /**
   * 管理员专用:把项目 owner 改成另一个 namespace(主账号 user.id 或子用户 subUser.id)。
   * 合法性(目标 namespace 真的存在)由 route 层校验,这里只负责持久化。
   * 找不到项目返 undefined,与 setPassword/setUnixUser 等存储方法语义对齐。
   */
  setOwnerId(id: string, ownerId: string): Project | undefined {
    const projects = this.load();
    const i = projects.findIndex((p) => p.id === id);
    if (i === -1) return undefined;
    projects[i] = { ...projects[i], ownerId };
    this.write(projects);
    return projects[i];
  }

  /**
   * 一次性迁移：给缺 ownerId 的存量项目回填为 adminId 并落盘（多用户上线前的项目都归 admin）。
   * 幂等：已有 ownerId 的不动；无需改动则不写盘。
   */
  migrate(adminId: string): void {
    const projects = this.load();
    let changed = false;
    const next = projects.map((p) => {
      if (!p.ownerId) {
        changed = true;
        return { ...p, ownerId: adminId };
      }
      return p;
    });
    if (changed) this.write(next);
  }

  /** 原子写：写临时文件再 rename；写前备份为 .bak。 */
  private write(projects: Project[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, `${this.file}.bak`);
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(projects, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || `proj-${Date.now()}`;
}
