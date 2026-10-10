/* Authentication for the exchange admin panel.
 *
 * Tokens are split exactly like the reference app:
 *   - Access: short-lived HMAC-signed JWT (HS256), role + type checked,
 *     carried by the admin UI in a header, never a cookie.
 *   - Refresh: an opaque random session id in an httpOnly cookie scoped to
 *     /api/admin, persisted in the blob store so rotation and logout actually
 *     revoke it rather than just forgetting it client-side.
 *
 * The password is verified with scrypt and a timing-safe compare. It is held
 * in the EXCHANGE_ADMIN_PASSWORD environment variable (server-side, like the
 * Brevo key) and never stored in the blob store.
 */

import {
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = 'refreshToken';

const base64Url = (buffer) =>
  Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const fromBase64Url = (value) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function scrypt(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/* Constant-time password comparison against the configured passphrase. Both
 * sides are hashed with the same fresh salt, so a wrong password and a missing
 * passphrase cost the same amount of work. */
export async function verifyPassword(attempt, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof attempt !== 'string' || attempt.length === 0) return false;
  try {
    const salt = randomBytes(16);
    const [a, e] = await Promise.all([
      scrypt(attempt, salt, 64),
      scrypt(expected, salt, 64),
    ]);
    return timingSafeEqual(a, e);
  } catch {
    return false;
  }
}

export function signAccessToken({ sub, role }, secret, ttlSeconds = ACCESS_TTL_SECONDS) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, role, type: 'access', iat: now, exp: now + ttlSeconds };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64Url(signature)}`;
}

export class TokenError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

/* Verify an access token. Rejects malformed headers, alg:none, a wrong type
 * or role, and expired tokens, in the same spirit as the adversarial suite in
 * the reference app. */
export function verifyAccessToken(token, secret, { role = 'ADMIN' } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new TokenError('token is malformed', 'malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('token is malformed', 'malformed');

  let header;
  let payload;
  try {
    header = JSON.parse(fromBase64Url(parts[0]).toString('utf8'));
    payload = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
  } catch {
    throw new TokenError('token is malformed', 'malformed');
  }

  if (header.alg !== 'HS256') {
    throw new TokenError(`unexpected alg ${header.alg}`, 'alg');
  }

  const expected = createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const supplied = Buffer.from(parts[2]);
  // timingSafeEqual throws on mismatched lengths, so an empty or wrong-length
  // signature (e.g. an alg:none forgery) must be refused here, not leaked as a
  // RangeError that the caller has to guess at.
  if (supplied.byteLength !== Buffer.byteLength(expected)) {
    throw new TokenError('token signature is invalid', 'signature');
  }
  if (!timingSafeEqual(Buffer.from(expected), supplied)) {
    throw new TokenError('token signature is invalid', 'signature');
  }

  if (payload.type !== 'access') {
    throw new TokenError('token type is not access', 'type');
  }
  if (payload.role !== role) {
    throw new TokenError('token role is not ' + role, 'role');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new TokenError('token is expired', 'expired');
  }
  if (typeof payload.sub !== 'string' || typeof payload.iat !== 'number') {
    throw new TokenError('token is malformed', 'malformed');
  }
  return payload;
}

const randomId = () => randomBytes(32).toString('hex');

export async function createRefreshSession(store, sub, ttlSeconds = REFRESH_TTL_SECONDS) {
  const jti = randomId();
  const now = Date.now();
  await store.set(`session:${jti}`, { sub, createdAt: now, exp: now + ttlSeconds * 1000 });
  return jti;
}

/* Validate and consume a refresh session, rotating it so a stolen cookie stops
 * working once used. Returns { jti, sub, cookie } on success. */
export async function rotateRefreshSession(store, jti, sub, ttlSeconds = REFRESH_TTL_SECONDS) {
  if (!jti || !/^[0-9a-f]{64}$/.test(jti)) return null;
  const record = await store.get(`session:${jti}`);
  if (!record || record.exp < Date.now()) return null;
  const old = record;
  await store.delete(`session:${jti}`);
  const next = await createRefreshSession(store, sub, ttlSeconds);
  return { previousJti: jti, jti: next, sub: old.sub };
}

export async function deleteRefreshSession(store, jti) {
  if (!jti || !/^[0-9a-f]{64}$/.test(jti)) return;
  await store.delete(`session:${jti}`);
}

export function refreshCookie(jti, ttlSeconds = REFRESH_TTL_SECONDS) {
  const maxAge = Math.floor(ttlSeconds);
  return [
    `${COOKIE_NAME}=${jti}`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function clearRefreshCookie() {
  return `${COOKIE_NAME}=; Path=/api/admin; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export function readRefreshJti(event) {
  const header = event.headers && (
    event.headers.cookie ||
    event.headers.Cookie ||
    event.headers['x-refresh-token']
  );
  if (!header) return null;
  const match = String(header).match(new RegExp(`${COOKIE_NAME}=([0-9a-f]+)`));
  return match ? match[1] : null;
}

export function bearerToken(event) {
  const header = event.headers && (event.headers.authorization || event.headers.Authorization);
  if (!header) return null;
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function safeTokenPreview(token) {
  if (typeof token !== 'string') return '(none)';
  return token.slice(0, 8) + '...';
}