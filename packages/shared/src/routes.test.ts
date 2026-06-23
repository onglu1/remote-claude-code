import { describe, it, expect } from 'vitest';
import { parseRoute, buildRoute, type Route } from './routes';

describe('parseRoute', () => {
  it('根 → projects', () => {
    expect(parseRoute('/')).toEqual({ name: 'projects' });
    expect(parseRoute('')).toEqual({ name: 'projects' });
  });

  it('/projects/:id → project(sessions)', () => {
    expect(parseRoute('/projects/htransformer')).toEqual({
      name: 'project',
      projectId: 'htransformer',
      tab: 'sessions',
    });
  });

  it('/projects/:id/files → project(files)', () => {
    expect(parseRoute('/projects/p1/files')).toEqual({
      name: 'project',
      projectId: 'p1',
      tab: 'files',
    });
  });

  it('/projects/:id/tasks(legacy) → project(research) 别名重定向', () => {
    expect(parseRoute('/projects/p1/tasks')).toEqual({
      name: 'project',
      projectId: 'p1',
      tab: 'research',
    });
  });

  it('/projects/:id/research → project(research)', () => {
    expect(parseRoute('/projects/foo/research')).toEqual({
      name: 'project',
      projectId: 'foo',
      tab: 'research',
    });
  });

  it('/projects/:id/<未知 tab> → unknown', () => {
    expect(parseRoute('/projects/p1/whatever')).toEqual({ name: 'unknown' });
  });

  it('会话 chat 视图', () => {
    expect(parseRoute('/projects/p1/conversations/c9/chat')).toEqual({
      name: 'conversation',
      projectId: 'p1',
      convId: 'c9',
      view: 'chat',
    });
  });

  it('会话 terminal 视图', () => {
    expect(parseRoute('/projects/p1/conversations/c9/terminal')).toEqual({
      name: 'conversation',
      projectId: 'p1',
      convId: 'c9',
      view: 'terminal',
    });
  });

  it('会话无视图后缀 → view:null', () => {
    expect(parseRoute('/projects/p1/conversations/c9')).toEqual({
      name: 'conversation',
      projectId: 'p1',
      convId: 'c9',
      view: null,
    });
  });

  it('会话未知视图后缀 → unknown', () => {
    expect(parseRoute('/projects/p1/conversations/c9/bogus')).toEqual({ name: 'unknown' });
  });

  it('/resources → resources', () => {
    expect(parseRoute('/resources')).toEqual({ name: 'resources' });
  });

  it('/users → users', () => {
    expect(parseRoute('/users')).toEqual({ name: 'users' });
  });

  it('完全陌生路径 → unknown', () => {
    expect(parseRoute('/nope')).toEqual({ name: 'unknown' });
    expect(parseRoute('/projects')).toEqual({ name: 'unknown' });
    expect(parseRoute('/projects/p1/conversations')).toEqual({ name: 'unknown' });
  });

  it('容忍尾斜杠', () => {
    expect(parseRoute('/projects/p1/')).toEqual({
      name: 'project',
      projectId: 'p1',
      tab: 'sessions',
    });
    expect(parseRoute('/resources/')).toEqual({ name: 'resources' });
    expect(parseRoute('/projects/p1/conversations/c9/chat/')).toEqual({
      name: 'conversation',
      projectId: 'p1',
      convId: 'c9',
      view: 'chat',
    });
  });

  it('对路径段做 decodeURIComponent（含特殊字符的 id）', () => {
    expect(parseRoute('/projects/a%2Fb')).toEqual({
      name: 'project',
      projectId: 'a/b',
      tab: 'sessions',
    });
    expect(parseRoute('/projects/p1/conversations/c%20x/terminal')).toEqual({
      name: 'conversation',
      projectId: 'p1',
      convId: 'c x',
      view: 'terminal',
    });
  });
});

describe('buildRoute', () => {
  it('projects → /', () => {
    expect(buildRoute({ name: 'projects' })).toBe('/');
  });

  it('project 各 tab', () => {
    expect(buildRoute({ name: 'project', projectId: 'p1', tab: 'sessions' })).toBe('/projects/p1');
    expect(buildRoute({ name: 'project', projectId: 'p1', tab: 'files' })).toBe('/projects/p1/files');
    expect(buildRoute({ name: 'project', projectId: 'foo', tab: 'research' })).toBe('/projects/foo/research');
  });

  it('conversation 两视图', () => {
    expect(buildRoute({ name: 'conversation', projectId: 'p1', convId: 'c9', view: 'chat' })).toBe(
      '/projects/p1/conversations/c9/chat',
    );
    expect(
      buildRoute({ name: 'conversation', projectId: 'p1', convId: 'c9', view: 'terminal' }),
    ).toBe('/projects/p1/conversations/c9/terminal');
  });

  it('conversation view:null → 无后缀规范 URL', () => {
    expect(buildRoute({ name: 'conversation', projectId: 'p1', convId: 'c9', view: null })).toBe(
      '/projects/p1/conversations/c9',
    );
  });

  it('resources / users / unknown', () => {
    expect(buildRoute({ name: 'resources' })).toBe('/resources');
    expect(buildRoute({ name: 'users' })).toBe('/users');
    expect(buildRoute({ name: 'unknown' })).toBe('/');
  });

  it('对 id 段做 encodeURIComponent', () => {
    expect(buildRoute({ name: 'project', projectId: 'a/b', tab: 'sessions' })).toBe('/projects/a%2Fb');
    expect(
      buildRoute({ name: 'conversation', projectId: 'p1', convId: 'c x', view: 'terminal' }),
    ).toBe('/projects/p1/conversations/c%20x/terminal');
  });
});

describe('round-trip parse∘build', () => {
  const cases: Route[] = [
    { name: 'projects' },
    { name: 'project', projectId: 'p1', tab: 'sessions' },
    { name: 'project', projectId: 'p1', tab: 'files' },
    { name: 'project', projectId: 'p1', tab: 'research' },
    { name: 'project', projectId: 'a/b weird', tab: 'files' },
    { name: 'conversation', projectId: 'p1', convId: 'c9', view: 'chat' },
    { name: 'conversation', projectId: 'p1', convId: 'c9', view: 'terminal' },
    { name: 'conversation', projectId: 'p1', convId: 'c9', view: null },
    { name: 'conversation', projectId: 'a b', convId: 'x/y', view: 'chat' },
    { name: 'resources' },
    { name: 'users' },
  ];
  it.each(cases)('parse(build(%o)) 还原', (route) => {
    expect(parseRoute(buildRoute(route))).toEqual(route);
  });
});
