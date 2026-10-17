/* Netlify Function: site-wide admin. Owns ALL /api/admin/* and the public
 * posts read /api/posts.
 *
 * The admin panel is for the whole skycreation.dev site, not just the exchange:
 * the login is username/email + password (per-user scrypt hash in the SCI_ADMIN
 * blob store), sessions are rotating httpOnly refresh cookies, and the modules
 * are Dashboard, Exchange (orders/stats/rates), Posts, Settings, Audit and
 * Account. The SCI Exchange storefront itself stays in functions/exchange.mjs;
 * this function never serves a public exchange route.
 *
 * Data stores (see exchange-lib/store.mjs for consistency notes):
 *   SCI_EXCHANGE_ORDERS    orders, rate:current, setting:open, proofs meta
 *   SCI_EXCHANGE_PROOFS    proof binaries
 *   SCI_ADMIN              users, sessions, unified audit log, posts
 *
 * Routes:
 *   POST /api/admin/login        { identifier, password } -> token + refresh cookie
 *   POST /api/admin/logout
 *   POST /api/admin/refresh
 *   GET  /api/admin/session      who am I
 *   GET  /api/admin/dashboard?from&to&status    stats+series, rate, recent audit, posts
 *   GET  /api/admin/stats        (exchange, legacy alias)
 *   GET  /api/admin/orders...    (exchange, legacy alias)
 *   GET|POST /api/admin/rates    (exchange, legacy alias)
 *   GET  /api/admin/exchange/stats?from&to&status
 *   GET  /api/admin/exchange/orders?status&q&page&perPage
 *   GET  /api/admin/exchange/orders/:id
 *   POST /api/admin/exchange/orders/:id/approve|reject|complete|delete
 *   GET|POST /api/admin/exchange/rates
 *   GET  /api/admin/audit?page
 *   GET  /api/admin/posts                       both lists
 *   POST /api/admin/posts/:list                 create
 *   PUT  /api/admin/posts/:list/:id             update
 *   DELETE /api/admin/posts/:list/:id
 *   GET  /api/admin/settings                    { open, defaultRate, currentRate }
 *   POST /api/admin/settings                    { open?, defaultRate? } -> also applies live rate
 *   PATCH /api/admin/account                    { currentPassword, ... }
 *   GET  /api/posts                             public, both lists
 *
 * Environment:
 *   EXCHANGE_JWT_SECRET       HMAC secret for access tokens (required)
 *   RATE_LIMIT_HMAC_KEY       required in production (>= 32 chars)
 *   UPSTASH_REDIS_REST_URL    required in production (shared rate limiter)
 *   UPSTASH_REDIS_REST_TOKEN  required in production
 *   SKY_EXCHANGE_TEST=1       use in-memory stores + memory limiter (tests only)
 *
 * Security:
 *   - username/email + password, scrypt hash + per-user salt, timing-safe;
 *   - wrong identifier and wrong password answer the same;
 *   - 5 login attempts / IP / 15 minutes via shared Upstash limiter (429);
 *   - 15-minute HMAC access token (authVersion), 7-day rotating httpOnly refresh;
 *   - password change bumps authVersion and clears refresh sessions;
 *   - every admin write is audited with the acting user's email.
 */

import { randomBytes } from 'node:crypto';

import { openStores, readJson } from './exchange-lib/store.mjs';
import {
  cleanText,
  parseJsonBody,
  assertSafeKeys,
  parsePostInput,
  EMAIL_RE,
  POST_LISTS,
  isFiniteNumber,
} from './exchange-lib/validate.mjs';
import {
  verifyStoredHash,
  scryptHash,
  signAccessToken,
  verifyAccessToken,
  createRefreshSession,
  rotateRefreshSession,
  deleteRefreshSession,
  deleteAllRefreshSessions,
  refreshCookie,
  clearRefreshCookie,
  readRefreshJti,
  bearerToken,
  TokenError,
} from './exchange-lib/auth.mjs';
import { ok, fail, httpError, clientIp, pathOf } from './exchange-lib/http.mjs';
import { createOrderStore } from './exchange-lib/orders.mjs';
import {
  createMemoryRateLimiter,
  createProductionRateLimiter,
  enforceRateLimit,
  hashRateLimitIdentifier,
  resolveRateLimitHmacKey,
  RateLimiterError,
} from './exchange-lib/rate-limit.mjs';
import { isValidThbToMmkRate, ValidationError } from './exchange-lib/validate.mjs';

const USER_ID = 'primary';
const USER_ROLE = 'ADMIN';
const MAX_IDENTIFIER = 200;
const MAX_PASSWORD = 512;

let productionLimiterPromise;

/* ----------------------------------------------------------------- server */

export function createAdminServer({ store, proofs, admin, env = {}, limiter, limiterFactory } = {}) {
  const svc = createOrderStore({ store, proofs, auditStore: admin, env });
  const getEnv = (name) => {
    const override = env[name];
    return override !== undefined ? override : process.env[name];
  };

  const allowTestDefault =
    Boolean(limiter) || !limiterFactory || String(getEnv('SKY_EXCHANGE_TEST') || '') === '1';
  const rateLimitKey = resolveRateLimitHmacKey(
    { RATE_LIMIT_HMAC_KEY: getEnv('RATE_LIMIT_HMAC_KEY') },
    { allowTestDefault },
  );

  let loginLimiter = limiter || (limiterFactory ? null : createMemoryRateLimiter());

  async function getLoginLimiter() {
    if (limiterFactory && !loginLimiter) loginLimiter = await limiterFactory();
    return loginLimiter;
  }

  function authVersionOf(row) {
    return Number.isInteger(row && row.authVersion) && row.authVersion >= 0 ? row.authVersion : 0;
  }

  // ------------------------------------------------------------ user store

  async function readUser() {
    return readJson(admin, `user:${USER_ID}`);
  }

  async function writeUser(row) {
    await admin.set(`user:${USER_ID}`, row);
  }

  async function requireUser(event) {
    const payload = requireAdmin(event);
    const row = await readUser();
    if (!row) throw httpError(503, 'Admin account is not configured');
    if ((payload.authVersion || 0) !== authVersionOf(row)) {
      throw httpError(401, 'Session is no longer valid');
    }
    return { payload, row };
  }

  async function actorOf(adminPanelEvent) {
    const { row } = await requireUser(adminPanelEvent);
    return row.email || row.username;
  }

  // ---------------------------------------------------------------- auth

  function secretKey() {
    return String(getEnv('EXCHANGE_JWT_SECRET') || '');
  }

  function requireAdmin(event) {
    const secret = secretKey();
    if (!secret) throw httpError(503, 'Admin auth is not configured');
    const token = bearerToken(event);
    if (!token) throw httpError(401, 'Not authenticated');
    try {
      return verifyAccessToken(token, secret, { role: USER_ROLE });
    } catch (err) {
      if (err instanceof TokenError) {
        const status = err.code === 'role' ? 403 : 401;
        throw httpError(status, err.message);
      }
      throw err;
    }
  }

  async function adminLogin(event) {
    await enforceRateLimit({
      limiter: await getLoginLimiter(),
      namespace: 'admin-login',
      ip: clientIp(event),
      max: 5,
      windowSeconds: 15 * 60,
      hmacKey: rateLimitKey,
    });
    const secret = secretKey();
    if (!secret) throw httpError(503, 'Admin auth is not configured');
    const row = await readUser();
    if (!row) {
      console.error('admin: no user row seeded (run scripts/seed-admin.mjs)');
      throw httpError(503, 'Admin account is not configured');
    }

    const body = parseJsonBody(event);
    const identifier = cleanText(body.identifier, MAX_IDENTIFIER);
    const password = typeof body.password === 'string' ? body.password.slice(0, MAX_PASSWORD) : '';

    const identifierMatches =
      Boolean(identifier) &&
      (identifier.toLowerCase() === String(row.username || '').toLowerCase() ||
        identifier.toLowerCase() === String(row.email || '').toLowerCase());

    const okPassword = await verifyStoredHash(password, row.saltHex, row.hashHex);

    if (!identifierMatches || !okPassword) {
      // Same response for a wrong identifier and a wrong password. The shared
      // per-IP limit protects this endpoint without letting a third party lock
      // the only administrator out globally.
      await svc.audit('admin.login.failed', {
        identifierHash: hashRateLimitIdentifier(identifier || '(empty)', rateLimitKey),
        ipHash: hashRateLimitIdentifier(clientIp(event), rateLimitKey),
      }, 'anonymous');
      throw httpError(401, 'Invalid credentials');
    }

    row.authVersion = authVersionOf(row);
    row.lastLoginAt = new Date().toISOString();
    await writeUser(row);
    await svc.audit('admin.login', { ipHash: hashRateLimitIdentifier(clientIp(event), rateLimitKey) }, row.email || row.username);

    const jti = await createRefreshSession(admin, row.id || USER_ID, row.authVersion);
    const accessToken = signAccessToken({ sub: row.id || USER_ID, role: USER_ROLE, authVersion: row.authVersion }, secret);
    return ok(
      { ok: true, accessToken, role: USER_ROLE, expiresInSeconds: 15 * 60 },
      { 'Set-Cookie': refreshCookie(jti) },
    );
  }

  async function adminLogout(event) {
    let actor = null;
    try {
      actor = await actorOf(event);
    } catch (err) {
      if (!err || (err.status !== 401 && err.status !== 403)) throw err;
    }
    const jti = readRefreshJti(event);
    await deleteRefreshSession(admin, jti);
    if (actor) await svc.audit('admin.logout', {}, actor);
    return ok({ ok: true }, { 'Set-Cookie': clearRefreshCookie() });
  }

  async function adminRefresh(event) {
    const secret = secretKey();
    if (!secret) throw httpError(503, 'Admin auth is not configured');
    const jti = readRefreshJti(event);
    if (!jti) throw httpError(401, 'No refresh session');
    const row = await readUser();
    if (!row) throw httpError(503, 'Admin account is not configured');
    const rotated = await rotateRefreshSession(admin, jti, row.id || USER_ID, authVersionOf(row));
    if (!rotated) return fail(401, 'Refresh session is invalid or expired', { 'Set-Cookie': clearRefreshCookie() });
    const accessToken = signAccessToken({ sub: rotated.sub, role: USER_ROLE, authVersion: authVersionOf(row) }, secret);
    return ok(
      { ok: true, accessToken, role: USER_ROLE, expiresInSeconds: 15 * 60 },
      { 'Set-Cookie': refreshCookie(rotated.jti) },
    );
  }

  async function adminSession(event) {
    const { payload, row } = await requireUser(event);
    return ok({
      ok: true,
      sub: payload.sub,
      email: row.email,
      username: row.username,
      name: row.name,
      role: USER_ROLE,
      iat: payload.iat,
      exp: payload.exp,
    });
  }

  // ------------------------------------------------------------ dashboard

  function statsFiltersFrom(event) {
    const q = event.queryStringParameters || {};
    const status = q.status && ['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED'].includes(q.status)
      ? q.status
      : undefined;
    const from = typeof q.from === 'string' && q.from.trim() ? q.from.trim() : undefined;
    const to = typeof q.to === 'string' && q.to.trim() ? q.to.trim() : undefined;
    return { from, to, status };
  }

  async function adminDashboard(event) {
    await requireUser(event);
    const filters = statsFiltersFrom(event);
    const [stats, rates, audit] = await Promise.all([
      svc.adminStats(filters),
      svc.ratesGet(),
      svc.auditPage(admin, 1),
    ]);
    const [company, math] = await Promise.all([listPosts('company'), listPosts('math')]);
    return ok({
      stats,
      rate: { thbToMmk: rates.thbToMmk, mmkToThb: rates.mmkToThb, open: rates.open },
      recentRateHistory: (rates.history || []).slice(0, 5),
      recentAudit: audit.rows.slice(0, 5),
      posts: { company: company.length, math: math.length },
      filters: stats.filters,
    });
  }

  // ------------------------------------------------------------- exchange

  async function exchangeStats(event) {
    await requireUser(event);
    return ok(await svc.adminStats(statsFiltersFrom(event)));
  }

  async function exchangeOrders(event) {
    await requireUser(event);
    const q = event.queryStringParameters || {};
    const status = q.status && ['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED'].includes(q.status) ? q.status : undefined;
    const page = parseInt(q.page || '1', 10);
    const perPage = parseInt(q.perPage || '25', 10);
    return ok(await svc.adminOrdersPage({ status, q: q.q || '', page, perPage }));
  }

  async function exchangeOrder(event, id) {
    await requireUser(event);
    const order = await svc.readOrder(id);
    if (!order) throw httpError(404, 'Order not found');
    return ok({ ...svc.fullOrder(order), viewToken: order.viewToken });
  }

  async function exchangeTransition(event, id, action) {
    const actor = await actorOf(event);
    return ok(await svc.transition(id, action, actor));
  }

  async function exchangeRates(event) {
    if (event.httpMethod === 'GET') {
      await requireUser(event);
      return ok(await svc.ratesGet());
    }
    const actor = await actorOf(event);
    const body = parseJsonBody(event);
    return ok(await svc.ratesApply(body, actor));
  }

  // ---------------------------------------------------------------- posts

  function postKey(list, id) {
    return `post:${list}:${id}`;
  }

  async function listPosts(list) {
    const prefix = `post:${list}:`;
    const keys = (await admin.list({ prefix }))
      .map((entry) => entry.key)
      .sort()
      .reverse();
    const posts = [];
    for (const key of keys) {
      const post = await readJson(admin, key);
      if (!post) continue;
      posts.push({ id: key.slice(prefix.length), date: post.date, text: post.text, url: post.url || '' });
    }
    posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return posts;
  }

  async function postsRead(event) {
    await requireUser(event);
    const [company, math] = await Promise.all([listPosts('company'), listPosts('math')]);
    return ok({ company, math });
  }

  async function postsCreate(event, list) {
    const actor = await actorOf(event);
    if (!POST_LISTS.has(list)) throw httpError(404, 'Unknown post list');
    const body = parseJsonBody(event);
    let input;
    try {
      input = parsePostInput(body);
    } catch (err) {
      throw httpError(400, err.message);
    }
    const id = `${Date.now()}:${randomBytes(4).toString('hex')}`;
    await admin.set(postKey(list, id), {
      date: input.date,
      text: input.text,
      url: input.url,
      createdAt: new Date().toISOString(),
    });
    await svc.audit('post.created', { list, id, date: input.date }, actor);
    return ok({ ok: true, id });
  }

  async function postsUpdate(event, list, id) {
    const actor = await actorOf(event);
    if (!POST_LISTS.has(list)) throw httpError(404, 'Unknown post list');
    if (!/^[0-9]+:[0-9a-f]+$/.test(id)) throw httpError(400, 'Invalid post id');
    const key = postKey(list, id);
    const existing = await readJson(admin, key);
    if (!existing) throw httpError(404, 'Post not found');
    const body = parseJsonBody(event);
    let input;
    try {
      input = parsePostInput(body);
    } catch (err) {
      throw httpError(400, err.message);
    }
    await admin.set(key, {
      date: input.date,
      text: input.text,
      url: input.url,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    await svc.audit('post.updated', { list, id, date: input.date }, actor);
    return ok({ ok: true });
  }

  async function postsDelete(event, list, id) {
    const actor = await actorOf(event);
    if (!POST_LISTS.has(list)) throw httpError(404, 'Unknown post list');
    if (!/^[0-9]+:[0-9a-f]+$/.test(id)) throw httpError(400, 'Invalid post id');
    const key = postKey(list, id);
    const existing = await readJson(admin, key);
    if (!existing) throw httpError(404, 'Post not found');
    await admin.delete(key);
    await svc.audit('post.deleted', { list, id }, actor);
    return ok({ ok: true });
  }

  async function publicPosts() {
    const [company, math] = await Promise.all([listPosts('company'), listPosts('math')]);
    return ok({ company, math });
  }

  // ------------------------------------------------------------- settings

  async function settingsGet(event) {
    await requireUser(event);
    const open = await svc.getOpen();
    const configured = await readJson(store, 'setting:defaultRate');
    const defaultRate = isValidThbToMmkRate(configured)
      ? configured
      : isValidThbToMmkRate(Number(getEnv('EXCHANGE_RATE_DEFAULT')))
        ? Number(getEnv('EXCHANGE_RATE_DEFAULT'))
        : undefined;
    const rate = await svc.getRate();
    return ok({ open, defaultRate: defaultRate || rate.thbToMmk, currentRate: rate.thbToMmk });
  }

  async function settingsUpdate(event) {
    const actor = await actorOf(event);
    const body = parseJsonBody(event);
    if (body.open !== undefined && typeof body.open !== 'boolean') {
      throw httpError(400, 'open must be a boolean');
    }
    if (body.defaultRate !== undefined) {
      if (!isValidThbToMmkRate(body.defaultRate)) {
        throw httpError(400, 'defaultRate must be between 50 and 500');
      }
      // Keep the seed for empty-store recovery, and also push it live so
      // /exchange (which reads rate:current) picks the new value up.
      await store.set('setting:defaultRate', body.defaultRate);
      await svc.audit('settings.defaultRate', { thbToMmk: body.defaultRate }, actor);
    }
    const result = {};
    const applyBody = {};
    if (body.defaultRate !== undefined) applyBody.thbToMmk = body.defaultRate;
    if (body.open !== undefined) applyBody.open = body.open;
    if (Object.keys(applyBody).length) {
      const applied = await svc.ratesApply(applyBody, actor);
      if (applied.open !== undefined) result.open = applied.open;
      if (applied.thbToMmk !== undefined) {
        result.defaultRate = body.defaultRate;
        result.currentRate = applied.thbToMmk;
      }
    }
    if (result.currentRate === undefined) {
      const rate = await svc.getRate();
      result.currentRate = rate.thbToMmk;
    }
    return ok({ ok: true, ...result });
  }

  // ------------------------------------------------------- unified audit

  async function adminAudit(event) {
    await requireUser(event);
    const q = event.queryStringParameters || {};
    const page = Math.max(1, parseInt(q.page || '1', 10));
    return ok(await svc.auditPage(admin, page));
  }

  // --------------------------------------------------------------- account

  async function accountUpdate(event) {
    const { payload, row } = await requireUser(event);
    if (!row) throw httpError(503, 'Admin account is not configured');
    const body = parseJsonBody(event);
    if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
      throw httpError(400, 'currentPassword is required');
    }
    const okPassword = await verifyStoredHash(
      body.currentPassword.slice(0, MAX_PASSWORD),
      row.saltHex,
      row.hashHex,
    );
    if (!okPassword) throw httpError(403, 'Current password is incorrect');

    const next = { ...row };
    if (body.username !== undefined) {
      const username = cleanText(body.username, 64);
      if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
        throw httpError(400, 'username must be 3-64 characters of letters, numbers, . _ -');
      }
      next.username = username;
    }
    if (body.email !== undefined) {
      const email = cleanText(body.email, 200).toLowerCase();
      if (!EMAIL_RE.test(email)) throw httpError(400, 'email is invalid');
      next.email = email;
    }
    if (body.name !== undefined) {
      next.name = cleanText(body.name, 120);
    }
    if (body.newPassword !== undefined) {
      const fresh = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (fresh.length < 8 || fresh.length > 256) {
        throw httpError(400, 'newPassword must be between 8 and 256 characters');
      }
      const { saltHex, hashHex } = await scryptHash(fresh);
      next.saltHex = saltHex;
      next.hashHex = hashHex;
      next.passwordChangedAt = new Date().toISOString();
      next.authVersion = authVersionOf(row) + 1;
    }

    await writeUser(next);
    await svc.audit('account.updated', { fields: Object.keys(body).filter((k) => k !== 'currentPassword') }, next.email);
    if (body.newPassword !== undefined) {
      await deleteAllRefreshSessions(admin, next.id || USER_ID);
      return ok(
        { ok: true, username: next.username, email: next.email, name: next.name, signedOut: true },
        { 'Set-Cookie': clearRefreshCookie() },
      );
    }
    return ok({ ok: true, username: next.username, email: next.email, name: next.name });
  }

  // ------------------------------------------------------------- dispatch

  async function route(event) {
    const method = (event.httpMethod || 'GET').toUpperCase();
    const path = pathOf(event);
    const parts = path.split('/').filter(Boolean);

    try {
      // Public posts read (no auth): the site fetches both lists from here.
      if (parts[0] === 'api' && parts[1] === 'posts' && parts.length === 2 && method === 'GET') {
        return await publicPosts();
      }

      if (parts[0] !== 'api' || parts[1] !== 'admin') {
        throw httpError(404, 'Not found');
      }
      const seg = parts.slice(2);

      // ---- /api/admin/exchange/* (current) -------------------------------
      if (seg[0] === 'exchange') {
        const s = seg.slice(1);
        if (s.length === 1 && s[0] === 'stats' && method === 'GET') return await exchangeStats(event);
        if (s.length === 1 && s[0] === 'orders' && method === 'GET') return await exchangeOrders(event);
        if (s.length === 2 && s[0] === 'orders' && method === 'GET') return await exchangeOrder(event, s[1]);
        if (
          s.length === 3 &&
          s[0] === 'orders' &&
          method === 'POST' &&
          (s[2] === 'approve' || s[2] === 'reject' || s[2] === 'complete' || s[2] === 'delete')
        ) {
          return await exchangeTransition(event, s[1], s[2]);
        }
        if (s.length === 1 && s[0] === 'rates' && method === 'GET') return await exchangeRates(event);
        if (s.length === 1 && s[0] === 'rates' && method === 'POST') return await exchangeRates(event);
        throw httpError(404, 'Not found');
      }

      // ---- top-level admin ------------------------------------------------
      if (seg.length === 1) {
        const s = seg[0];
        if (s === 'login' && method === 'POST') return await adminLogin(event);
        if (s === 'logout' && method === 'POST') return await adminLogout(event);
        if (s === 'refresh' && method === 'POST') return await adminRefresh(event);
        if (s === 'session' && method === 'GET') return await adminSession(event);
        if (s === 'dashboard' && method === 'GET') return await adminDashboard(event);
        if (s === 'stats' && method === 'GET') return await exchangeStats(event); // legacy alias
        if (s === 'orders' && method === 'GET') return await exchangeOrders(event); // legacy alias
        if (s === 'rates' && method === 'GET') return await exchangeRates(event); // legacy alias
        if (s === 'rates' && method === 'POST') return await exchangeRates(event); // legacy alias
        if (s === 'audit' && method === 'GET') return await adminAudit(event);
        if (s === 'posts' && method === 'GET') return await postsRead(event);
        if (s === 'settings' && method === 'GET') return await settingsGet(event);
        if (s === 'settings' && method === 'POST') return await settingsUpdate(event);
        if (s === 'account' && method === 'PATCH') return await accountUpdate(event);
        throw httpError(404, 'Not found');
      }

      // ---- top-level admin with segments (legacy exchange order aliases,
      //      posts CRUD) ----------------------------------------------------
      if (seg[0] === 'orders') {
        // Legacy aliases (pre-module paths): list is seg.length === 1 above;
        // GET /api/admin/orders/:id is detail; POST .../:id/:action transitions.
        if (seg.length === 2 && method === 'GET') return await exchangeOrder(event, seg[1]);
        if (
          seg.length === 3 &&
          method === 'POST' &&
          (seg[2] === 'approve' || seg[2] === 'reject' || seg[2] === 'complete' || seg[2] === 'delete')
        ) {
          return await exchangeTransition(event, seg[1], seg[2]);
        }
      }
      if (seg[0] === 'posts') {
        if (seg.length === 2 && method === 'POST') return await postsCreate(event, seg[1]);
        if (seg.length === 3 && method === 'PUT') return await postsUpdate(event, seg[1], seg[2]);
        if (seg.length === 3 && method === 'DELETE') return await postsDelete(event, seg[1], seg[2]);
      }

      throw httpError(404, 'Not found');
    } catch (err) {
      if (err instanceof RateLimiterError) {
        const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : undefined;
        return fail(err.status, err.message, headers);
      }
      if (err && err.status) return fail(err.status, err.message);
      if (err && err.code === 'TOO_LARGE') return fail(413, 'Request too large');
      if (err instanceof ValidationError || (err && ['INVALID_JSON', 'INVALID_BODY', 'UNSAFE_KEYS', 'INVALID_INPUT'].includes(err.code))) {
        return fail(400, err.message);
      }
      console.error('admin: unhandled error', err && err.stack ? err.stack : err);
      return fail(500, 'Server error');
    }
  }

  return { route };
}

export const handler = async (event) => {
  try {
    const { store, proofs, admin } = await openStores(event);
    const testMode = process.env.SKY_EXCHANGE_TEST === '1';
    if (!testMode) {
      productionLimiterPromise = productionLimiterPromise || createProductionRateLimiter(process.env);
    }
    const server = createAdminServer({
      store,
      proofs,
      admin,
      env: process.env,
      limiter: testMode ? createMemoryRateLimiter() : undefined,
      limiterFactory: testMode ? undefined : () => productionLimiterPromise,
    });
    return await server.route(event);
  } catch (err) {
    if (err instanceof RateLimiterError) {
      return fail(err.status, err.message);
    }
    console.error('admin: unavailable', err && err.message ? err.message : err);
    return fail(503, 'Service temporarily unavailable');
  }
};
