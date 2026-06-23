import { describe, it, expect } from 'vitest';
import {
  ProjectSchema,
  EffortLevelSchema,
  ConversationSchema,
  RoleSchema,
  UserSchema,
  AuthUserSchema,
  ScrollbackChunkSchema,
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

  it('AuthUser 只含脱敏字段', () => {
    const a = AuthUserSchema.parse({ id: 'u1', username: 'alice', role: 'admin' });
    expect(a).toEqual({ id: 'u1', username: 'alice', role: 'admin' });
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
