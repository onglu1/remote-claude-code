import { describe, it, expect } from 'vitest';
import {
  ProjectSchema,
  EffortLevelSchema,
  ConversationSchema,
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
  it('合法子用户解析,settings 默认值', () => {
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
