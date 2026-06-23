import crypto from 'node:crypto';

const COOKIE_NAME = 'rcc_token';
export { COOKIE_NAME };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(secret: string, data: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(data).digest());
}

/** token 解出的会话主体。 */
export interface TokenPayload {
  userId: string;
}

/** 签发一个带过期时间、绑定 userId 的 token：base64url(payload).signature */
export function signToken(secret: string, ttlMs: number, userId: string, now = Date.now()): string {
  const payload = b64url(Buffer.from(JSON.stringify({ sub: userId, exp: now + ttlMs })));
  return `${payload}.${hmac(secret, payload)}`;
}

/** 校验 token：签名正确、未过期且带 sub。成功返回 {userId}，否则 null。 */
export function verifyToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): TokenPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(secret, payload);
  // 定长比较，避免时序侧信道
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof exp !== 'number' || exp <= now) return null;
    if (typeof sub !== 'string' || sub.length === 0) return null;
    return { userId: sub };
  } catch {
    return null;
  }
}
