import { describe, it, expect } from 'vitest';
import {
  ProjectSchema,
  EffortLevelSchema,
  ConversationSchema,
  ConversationCreateSchema,
  AgentKindSchema,
  AgentAccessConfigSchema,
  RoleSchema,
  UserSchema,
  SubUserSchema,
  AuthUserSchema,
  ScrollbackChunkSchema,
  FolderSchema,
} from './schemas';
import { decodeClientMessage } from './ws';

describe('ScrollbackChunkSchema', () => {
  it('解析合法 chunk', () => {
    const v = ScrollbackChunkSchema.parse({ lines: ['a', 'b'], nextBefore: 3, atTop: false });
    expect(v.lines).toEqual(['a', 'b']);
    expect(v.nextBefore).toBe(3);
    expect(v.atTop).toBe(false);
  });
  it('nextBefore 可为 null', () => {
    const v = ScrollbackChunkSchema.parse({ lines: [], nextBefore: null, atTop: true });
    expect(v.nextBefore).toBeNull();
  });
});

describe('EffortLevelSchema / Conversation.effort', () => {
  it('effort 枚举校验', () => {
    expect(EffortLevelSchema.parse('max')).toBe('max');
    expect(() => EffortLevelSchema.parse('ultra')).toThrow();
  });
  it('会话 effort 默认 max', () => {
    const c = ConversationSchema.parse({
      id: 'a',
      projectId: 'p',
      name: 'n',
      tmuxName: 't',
      sessionId: 's',
      alive: false,
      createdAt: '2026-01-01',
    });
    expect(c.effort).toBe('max');
  });
});

describe('AgentAccessConfigSchema', () => {
  it('缺字段时两个 agent 默认不限制', () => {
    const cfg = AgentAccessConfigSchema.parse({});
    expect(cfg.claude).toEqual({ enabled: false, allowedPrincipalIds: [] });
    expect(cfg.codex).toEqual({ enabled: false, allowedPrincipalIds: [] });
  });

  it('接受分 agent 白名单', () => {
    const cfg = AgentAccessConfigSchema.parse({
      claude: { enabled: true, allowedPrincipalIds: ['u1', 's1'] },
      codex: { enabled: false, allowedPrincipalIds: [] },
    });
    expect(cfg.claude.enabled).toBe(true);
    expect(cfg.claude.allowedPrincipalIds).toEqual(['u1', 's1']);
  });
});

describe('ProjectSchema', () => {
  it('接受合法项目并填充默认 launchCommand', () => {
    const p = ProjectSchema.parse({
      id: 'my-research',
      name: 'My Research',
      path: '/home/me/projects/my-research',
      type: 'research',
    });
    expect(p.launchCommand).toBe('Fable-yolo');
  });

  it('拒绝非法 type', () => {
    expect(() =>
      ProjectSchema.parse({ id: 'x', name: 'X', path: '/x', type: 'other' }),
    ).toThrow();
  });

  it('拒绝非法 id', () => {
    expect(() =>
      ProjectSchema.parse({ id: 'Bad Id', name: 'X', path: '/x', type: 'dev' }),
    ).toThrow();
  });

  it('缺 ownerId 仍合法（兼容存量）', () => {
    const p = ProjectSchema.parse({ id: 'x', name: 'X', path: '/x', type: 'dev' });
    expect(p.ownerId).toBeUndefined();
  });

  it('带 ownerId 合法', () => {
    const p = ProjectSchema.parse({ id: 'x', name: 'X', path: '/x', type: 'dev', ownerId: 'u1' });
    expect(p.ownerId).toBe('u1');
  });
});

describe('RoleSchema / UserSchema / AuthUserSchema', () => {
  it('Role 只接受 admin/user', () => {
    expect(RoleSchema.parse('admin')).toBe('admin');
    expect(RoleSchema.parse('user')).toBe('user');
    expect(() => RoleSchema.parse('root')).toThrow();
  });

  it('User 合法解析', () => {
    const u = UserSchema.parse({
      id: 'u1',
      username: 'alice',
      passwordHash: '$argon2id$xxx',
      role: 'user',
      createdAt: '2026-06-21T00:00:00.000Z',
    });
    expect(u.username).toBe('alice');
    expect(u.role).toBe('user');
  });

  it('User 拒绝非法 role', () => {
    expect(() =>
      UserSchema.parse({
        id: 'u1',
        username: 'a',
        passwordHash: 'h',
        role: 'super',
        createdAt: '2026-06-21',
      }),
    ).toThrow();
  });

  it('AuthUser 主账号形态', () => {
    const a = AuthUserSchema.parse({
      id: 'u1', username: 'alice', role: 'admin',
      kind: 'user', unixUser: 'alice', namespaceId: 'u1',
    });
    expect(a.kind).toBe('user');
    expect(a.parentId).toBeUndefined();
    expect(a.namespaceId).toBe('u1');
  });

  it('AuthUser 子用户形态(含 parentId,unixUser 从父继承)', () => {
    const a = AuthUserSchema.parse({
      id: 's1', username: 'alice_dev', role: 'user',
      kind: 'subuser', parentId: 'u1', unixUser: 'alice', namespaceId: 's1',
    });
    expect(a.kind).toBe('subuser');
    expect(a.parentId).toBe('u1');
  });
});

describe('ConversationSchema 扩字段', () => {
  it('starred 默认 false', () => {
    const c = ConversationSchema.parse({
      id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      alive: false, createdAt: '2026-01-01T00:00:00Z',
    });
    expect(c.starred).toBe(false);
    expect(c.folderId).toBeUndefined();
    expect(c.closedAt).toBeUndefined();
    expect(c.lastActivityAt).toBeUndefined();
  });

  it('接受 folderId / starred=true / closedAt / lastActivityAt', () => {
    const c = ConversationSchema.parse({
      id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      alive: false, createdAt: '2026-01-01T00:00:00Z',
      folderId: 'fld_1', starred: true,
      closedAt: '2026-01-02T00:00:00Z',
      lastActivityAt: '2026-01-01T05:00:00Z',
    });
    expect(c.folderId).toBe('fld_1');
    expect(c.starred).toBe(true);
    expect(c.closedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('folderId 可以是 null(显式未分类)', () => {
    const c = ConversationSchema.parse({
      id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      alive: false, createdAt: '2026-01-01T00:00:00Z',
      folderId: null,
    });
    expect(c.folderId).toBeNull();
  });
});

describe('FolderSchema', () => {
  it('完整字段解析', () => {
    const f = FolderSchema.parse({
      id: 'fld_abc12345', projectId: 'p', ownerId: 'u',
      name: '工程', sortOrder: 0,
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(f.name).toBe('工程');
    expect(f.sortOrder).toBe(0);
  });

  it('sortOrder 缺省=0', () => {
    const f = FolderSchema.parse({
      id: 'fld_abc12345', projectId: 'p', ownerId: 'u',
      name: 'x', createdAt: '2026-01-01T00:00:00Z',
    });
    expect(f.sortOrder).toBe(0);
  });

  it('name 长度上限 40', () => {
    expect(() =>
      FolderSchema.parse({
        id: 'fld_x', projectId: 'p', ownerId: 'u',
        name: 'x'.repeat(41), createdAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });
});

describe('SubUserSchema', () => {
  it('合法子用户解析,settings 默认值,role 默认 user(兼容存量)', () => {
    const s = SubUserSchema.parse({
      id: 's1',
      parentId: 'u1',
      username: 'alice_dev',
      passwordHash: 'h',
      displayName: '开发',
      createdAt: '2026-06-23T00:00:00Z',
    });
    expect(s.parentId).toBe('u1');
    expect(s.settings.idleCloseHours).toBe(3);
    expect(s.role).toBe('user');
  });

  it('显式 role=admin 合法(由路由层约束 <= parent.role)', () => {
    const s = SubUserSchema.parse({
      id: 's1', parentId: 'u1',
      username: 'a', passwordHash: 'h', displayName: 'd',
      createdAt: '2026-06-23T00:00:00Z',
      role: 'admin',
    });
    expect(s.role).toBe('admin');
  });

  it('displayName 长度上限 40', () => {
    expect(() =>
      SubUserSchema.parse({
        id: 's1',
        parentId: 'u1',
        username: 'alice_dev',
        passwordHash: 'h',
        displayName: 'x'.repeat(41),
        createdAt: '2026-06-23T00:00:00Z',
      }),
    ).toThrow();
  });
});

describe('UserSchema with unixUser', () => {
  it('接受带 unixUser 的用户', () => {
    const u = UserSchema.parse({
      id: 'u1',
      username: 'alice',
      passwordHash: 'h',
      role: 'user',
      createdAt: '2026-06-23T00:00:00Z',
      unixUser: 'alice',
    });
    expect(u.unixUser).toBe('alice');
  });

  it('不带 unixUser 仍合法(兼容存量,context 启动时回填)', () => {
    const u = UserSchema.parse({
      id: 'u1',
      username: 'alice',
      passwordHash: 'h',
      role: 'user',
      createdAt: '2026-06-23T00:00:00Z',
    });
    expect(u.unixUser).toBeUndefined();
  });
});

describe('decodeClientMessage', () => {
  it('解析 input', () => {
    expect(decodeClientMessage('{"type":"input","data":"ls\\r"}')).toEqual({
      type: 'input',
      data: 'ls\r',
    });
  });
  it('解析 resize', () => {
    expect(decodeClientMessage('{"type":"resize","cols":80,"rows":24}')).toEqual({
      type: 'resize',
      cols: 80,
      rows: 24,
    });
  });
  it('非法返回 null', () => {
    expect(decodeClientMessage('not json')).toBeNull();
    expect(decodeClientMessage('{"type":"bogus"}')).toBeNull();
  });
});

describe('AgentKindSchema', () => {
  it('accepts claude and codex', () => {
    expect(AgentKindSchema.parse('claude')).toBe('claude');
    expect(AgentKindSchema.parse('codex')).toBe('codex');
  });
  it('rejects other strings', () => {
    expect(() => AgentKindSchema.parse('gemini')).toThrow();
  });
});

describe('ConversationSchema agentKind/launchCommand 字段', () => {
  const base = {
    id: 'a1',
    projectId: 'p',
    name: 'demo',
    tmuxName: 't',
    sessionId: '11111111-1111-1111-1111-111111111111',
    alive: true,
    createdAt: '2026-06-25T00:00:00.000Z',
  };
  it('agentKind 缺省回填 claude', () => {
    const c = ConversationSchema.parse({ ...base });
    expect(c.agentKind).toBe('claude');
  });
  it('agentKind 显式 codex 通过', () => {
    const c = ConversationSchema.parse({ ...base, agentKind: 'codex' });
    expect(c.agentKind).toBe('codex');
  });
  it('launchCommand 可选;非空字符串通过、空串拒', () => {
    expect(ConversationSchema.parse({ ...base }).launchCommand).toBeUndefined();
    expect(ConversationSchema.parse({ ...base, launchCommand: 'codex --yolo' }).launchCommand).toBe('codex --yolo');
    expect(() => ConversationSchema.parse({ ...base, launchCommand: '' })).toThrow();
  });
  it('codexSessionDiscovered 缺省 false', () => {
    expect(ConversationSchema.parse({ ...base }).codexSessionDiscovered).toBe(false);
  });
});

describe('ConversationCreateSchema', () => {
  it('全可选;空对象通过', () => {
    expect(ConversationCreateSchema.parse({})).toEqual({});
  });
  it('agentKind/launchCommand 透传', () => {
    const c = ConversationCreateSchema.parse({ agentKind: 'codex', launchCommand: 'codex --yolo' });
    expect(c.agentKind).toBe('codex');
    expect(c.launchCommand).toBe('codex --yolo');
  });
  it('sessionId 必须是 UUID 格式', () => {
    expect(() => ConversationCreateSchema.parse({ sessionId: 'not-uuid' })).toThrow();
    expect(ConversationCreateSchema.parse({ sessionId: '11111111-1111-1111-1111-111111111111' }).sessionId).toBeTruthy();
  });
});
