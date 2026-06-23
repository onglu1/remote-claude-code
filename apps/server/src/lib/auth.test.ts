import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from './auth';

describe('token', () => {
  const secret = 'a-very-secret-key';

  it('签发的 token 可被验证并解出 userId', () => {
    const t = signToken(secret, 1000, 'user-123');
    const r = verifyToken(secret, t);
    expect(r).toEqual({ userId: 'user-123' });
  });

  it('错误密钥验证失败', () => {
    const t = signToken(secret, 1000, 'u');
    expect(verifyToken('wrong', t)).toBeNull();
  });

  it('过期 token 失败', () => {
    const now = Date.now();
    const t = signToken(secret, 1000, 'u', now);
    expect(verifyToken(secret, t, now + 2000)).toBeNull();
  });

  it('未过期 token 在 ttl 内有效', () => {
    const now = Date.now();
    const t = signToken(secret, 5000, 'u', now);
    expect(verifyToken(secret, t, now + 1000)).toEqual({ userId: 'u' });
  });

  it('篡改 token 失败', () => {
    const t = signToken(secret, 1000, 'u');
    expect(verifyToken(secret, t + 'x')).toBeNull();
    expect(verifyToken(secret, undefined)).toBeNull();
  });
});
