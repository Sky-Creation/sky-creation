/* Netlify Function: SCI Exchange app (public + admin).
 *
 * Routes (all same-origin, rewired in netlify.toml):
 *   GET  /api/exchange/rates
 *   POST /api/exchange/calculate
 *   POST /api/exchange/orders
 *   POST /api/exchange/orders/list
 *   GET  /api/exchange/orders/:id
 *   POST /api/exchange/orders/:id/proof          JSON { token, mimeType, dataBase64 }
 *   GET  /api/exchange/orders/:id/proof?token=
 *   POST /api/admin/login          -> { accessToken } + httpOnly refresh cookie
 *   POST /api/admin/logout
 *   POST /api/admin/refresh
 *   GET  /api/admin/session
 *   GET  /api/admin/stats
 *   GET  /api/admin/orders?status&q&page&perPage
 *   GET  /api/admin/orders/:id
 *   POST /api/admin/orders/:id/approve|reject|complete|delete
 *   GET  /api/admin/rates
 *   POST /api/admin/rates          { thbToMmk?, open? }
 *   GET  /api/admin/audit?page
 *
 * Environment:
 *   EXCHANGE_JWT_SECRET       HMAC secret for admin access tokens (required)
 *   EXCHANGE_ADMIN_PASSWORD   admin passcode (required; never stored)
 *   EXCHANGE_RATE_DEFAULT     optional seed THB->MMK rate (default 128.5)
 *   SKY_EXCHANGE_TEST=1       use in-memory stores (tests only)
 *
 * Security notes, mirroring the reference app:
 *   - every amount is validated with Number.isFinite (JSON.parse("1e309")
 *     yields Infinity), positive and bounded;
 *   - recognised prototype-pollution keys are rejected before use;
 *   - order details are redacted publicly unless the caller holds the per-order
 *     viewToken; tokens are 48 hex chars and are returned to the creator once;
 *   - the admin password is compared with scrypt + timingSafeEqual and login is
 *     rate limited per IP; refresh sessions are rotated on use;
 *   - the honeypot field ("company") is the only success-without-persistence
 *     path, matching the contact form.
 */

import { randomBytes, createHash } from 'node:crypto';

import { openStores, readJson, readBinary, writeBinary } from './exchange-lib/store.mjs';
import {
  cleanText,
  parseJsonBody,
  parseOrderInput,
  parseProofInput,
  parseRateInput,
  assertSafeKeys,
  MAX_ORDER_AMOUNT,
  ORDER_STATUSES,
  LEVELS,
  isFiniteNumber,
} from './exchange-lib/validate.mjs';
import {
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
  createRefreshSession,
  rotateRefreshSession,
  deleteRefreshSession,
  refreshCookie,
  clearRefreshCookie,
  readRefreshJti,
  bearerToken,
  TokenError,
} from './exchange-lib/auth.mjs';

export { InMemoryStore } from './exchange-lib/store.mjs';

const MINIMUMS = { THB: 100, MMK: 10000 };
const DEFAULT_RATE = 128.5;

const DEFAULT_CHANNELS = [
  { id: 'KBZPay', name: 'KBZPay' },
  { id: 'WavePay', name: 'WavePay' },
  { id: 'PromptPay', name: 'PromptPay' },
  { id: 'KBank', name: 'KBank' },
];

/* ------------------------------------------------------------------ utils */

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function ok(payload, extraHeaders) {
  return json(200, payload, extraHeaders);
}

function fail(statusCode, message) {
  return json(statusCode, { error: message });
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.status = statusCode;
  return err;
}

function clientIp(event) {
  const forwarded = event.headers?.['x-nf-client-connection-ip'];
  if (forwarded) return String(forwarded);
  return String(event.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

function pathOf(event) {
  const q = event.queryStringParameters || {};
  // Some hosts expose the function URL rather than the original path; the
  // rewrite in netlify.toml can carry the subpath here as a fallback.
  if (typeof q.__exchange_path === 'string' && q.__exchange_path) {
    return q.__exchange_path;
  }
  return event.path || '';
}

function makeReference() {
  const time = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return `SC-${time}${rand}`;
}

function makeOrderId() {
  return `ord-${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

function makeViewToken() {
  return randomBytes(24).toString('hex');
}

function auditKey() {
  return `audit:${Date.now()}:${randomBytes(4).toString('hex')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roundCurrency(value, direction) {
  return direction === 'THB_TO_MMK'
    ? Math.round(value)
    : Math.round(value * 100) / 100;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/* ------------------------------------------------------------- rate limits */

function makeLimiter(max, windowMs) {
  const hits = new Map();
  return function limit(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(ip, recent);
      return true;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(key);
      }
    }
    return false;
  };
}

/* ----------------------------------------------------------------- server */

export function createServer({ store, proofs, env = {} } = {}) {
  const getEnv = (name) => {
    const override = env[name];
    return override !== undefined ? override : process.env[name];
  };

  const limitOrderCreate = makeLimiter(10, 10 * 60 * 1000);
  const limitLogin = makeLimiter(10, 10 * 60 * 1000);

  async function getRate() {
    let current = await readJson(store, 'rate:current');
    if (!current || !isFiniteNumber(current.thbToMmk) || current.thbToMmk <= 0) {
      const seed = Number(getEnv('EXCHANGE_RATE_DEFAULT')) || DEFAULT_RATE;
      current = {
        thbToMmk: seed,
        mmkToThb: round4(1 / seed),
        updatedAt: new Date().toISOString(),
        source: 'seed',
      };
      await store.set('rate:current', current);
      await store.set('rate:history:seed', {
        thbToMmk: seed,
        updatedAt: current.updatedAt,
        source: 'seed',
        actor: 'system',
      });
    }
    return {
      ...current,
      mmkToThb: isFiniteNumber(current.mmkToThb)
        ? current.mmkToThb
        : round4(1 / current.thbToMmk),
    };
  }

  async function getOpen() {
    const setting = await readJson(store, 'setting:open');
    return setting === null ? true : setting.open !== false;
  }

  async function getChannels() {
    const channels = await readJson(store, 'setting:channels');
    return channels || DEFAULT_CHANNELS;
  }

  async function audit(action, detail) {
    // Append-only: the entry lives under audit:<ts>:<rand> and adminAudit
    // lists the prefix. Never maintain a read-modify-write index here - Blobs
    // is eventually consistent and concurrent writes would lose entries.
    await store.set(auditKey(), { action, detail, createdAt: new Date().toISOString() });
  }

  function publicOrder(order) {
    return {
      id: order.id,
      reference: order.reference,
      status: order.status,
      direction: order.direction,
      amount: order.amount,
      receiveAmount: order.receiveAmount,
      rateUsed: order.rateUsed,
      method: order.method,
      level: order.level,
      fee: order.fee,
      hasProof: Boolean(order.proofAt),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      completedAt: order.completedAt || null,
      isRedacted: true,
    };
  }

  function fullOrder(order) {
    return {
      ...publicOrder(order),
      isRedacted: false,
      senderName: order.senderName,
      senderContact: order.senderContact,
      accountNo: order.accountNo || '',
      accountName: order.accountName || '',
      note: order.note || '',
      proofFileName: order.proofFileName || null,
    };
  }

  async function viewOrder(order, token) {
    if (!order) return null;
    const match = token && order.viewToken && token === order.viewToken;
    return match ? fullOrder(order) : publicOrder(order);
  }

  async function readOrder(id) {
    return readJson(store, `order:${id}`);
  }

async function writeOrder(order) {
  await store.set(`order:${order.id}`, order);
}

async function removeOrder(id) {
  // Listing is prefix-based (order: keys), so a delete is just a delete - no
  // index to keep in sync. A briefly-stale list read may still show the order
  // until the delete propagates; that settles within the Blobs window.
  await store.delete(`order:${id}`);
}

async function orderIds() {
  return (await store.list({ prefix: 'order:' })).map((entry) => entry.key.slice('order:'.length));
}

async function adminOrdersPage({ status, q, page, perPage }) {
  const wanted = Math.max(1, Math.min(50, perPage || 25));
  const offset = Math.max(0, (page || 1) - 1) * wanted;

  const matched = [];
  for (const id of await orderIds()) {
    const order = await readOrder(id);
    if (!order) continue;
    if (status && order.status !== status) continue;
    if (q) {
      const needle = q.toLowerCase();
      const hay = `${order.reference} ${order.senderName || ''} ${order.method}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    matched.push(order);
  }
  matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const rows = matched.slice(offset, offset + wanted).map(publicOrder);
  return { orders: rows, total: matched.length, page: offset / wanted + 1, perPage: wanted };
}

  /* ------------------------------------------------------------ public API */

  async function getRates() {
    const [rate, open, channels] = await Promise.all([getRate(), getOpen(), getChannels()]);
    return ok({
      open,
      thbToMmk: rate.thbToMmk,
      mmkToThb: rate.mmkToThb,
      updatedAt: rate.updatedAt,
      source: rate.source,
      minimums: MINIMUMS,
      levels: ['Standard', 'Express', 'VIP'].map((id) => ({ id, name: id })),
      channels,
    });
  }

  function quote(amount, direction, thbToMmk) {
    if (direction === 'THB_TO_MMK') {
      return {
        receiveAmount: Math.round(amount * thbToMmk),
        rateUsed: round4(thbToMmk),
        fee: 0,
      };
    }
    return {
      receiveAmount: Math.round((amount / thbToMmk) * 100) / 100,
      rateUsed: round4(1 / thbToMmk),
      fee: 0,
    };
  }

  async function calculate(event) {
    const body = parseJsonBody(event);
    assertSafeKeys(body, 'body');
    const direction = cleanText(body.direction, 32).toUpperCase();
    if (!['THB_TO_MMK', 'MMK_TO_THB'].includes(direction)) {
      throw httpError(400, 'direction must be THB_TO_MMK or MMK_TO_THB');
    }
    const amount = body.amount;
    if (!isFiniteNumber(amount) || amount <= 0 || amount > MAX_ORDER_AMOUNT) {
      throw httpError(400, 'amount must be a finite number greater than zero');
    }
    const min = direction === 'THB_TO_MMK' ? MINIMUMS.THB : MINIMUMS.MMK;
    if (amount < min) {
      throw httpError(400, `amount is below the minimum of ${min}`);
    }
    const rate = await getRate();
    if ((await getOpen()) === false) {
      throw httpError(503, 'The exchange is currently closed');
    }
    const result = quote(amount, direction, rate.thbToMmk);
    return ok({ direction, amount, ...result, minimums: MINIMUMS });
  }

  async function createOrder(event) {
    if (limitOrderCreate(clientIp(event))) {
      return json(429, { ok: true, discarded: true, error: 'rate limited' });
    }

    const body = parseJsonBody(event);
    assertSafeKeys(body, 'body');

    // Honeypot mirrors the contact form: a filled hidden field means a bot.
    // Report success and persist nothing, so the bot cannot tell.
    if (cleanText(body.company, 200)) {
      console.log('exchange: honeypot triggered, order discarded');
      return ok({ ok: true, discarded: true });
    }

    if ((await getOpen()) === false) {
      throw httpError(503, 'The exchange is currently closed');
    }

    const input = parseOrderInput(body);
    const min = input.direction === 'THB_TO_MMK' ? MINIMUMS.THB : MINIMUMS.MMK;
    if (input.amount < min) {
      throw httpError(400, `amount is below the minimum of ${min}`);
    }

    const rate = await getRate();
    const result = quote(input.amount, input.direction, rate.thbToMmk);

    const now = new Date().toISOString();
    const id = makeOrderId();
    const order = {
      id,
      reference: makeReference(),
      status: 'PENDING',
      direction: input.direction,
      amount: input.amount,
      receiveAmount: result.receiveAmount,
      rateUsed: result.rateUsed,
      fee: 0,
      method: input.method,
      level: input.level,
      senderName: input.senderName,
      senderContact: input.senderContact,
      accountNo: input.accountNo,
      accountName: input.accountName,
      note: input.note,
      viewToken: makeViewToken(),
      ip: clientIp(event),
      userAgent: String(event.headers?.['user-agent'] || '').slice(0, 300),
      createdAt: now,
      updatedAt: now,
    };

    await writeOrder(order);
    await audit('order.created', { id, reference: order.reference, direction: order.direction, amount: order.amount });

    return ok({
      ok: true,
      orderId: order.id,
      reference: order.reference,
      status: order.status,
      direction: order.direction,
      amount: order.amount,
      receiveAmount: order.receiveAmount,
      rateUsed: order.rateUsed,
      viewToken: order.viewToken,
    });
  }

  async function listOrders(event) {
    const body = parseJsonBody(event);
    if (!Array.isArray(body.orders)) {
      throw httpError(400, 'orders must be an array');
    }
    const entries = body.orders.slice(0, 50);
    const orders = [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') {
        orders.push(null);
        continue;
      }
      const order = await readOrder(entry.id);
      const token = typeof entry.viewToken === 'string' ? entry.viewToken : '';
      orders.push(await viewOrder(order, token));
    }
    return ok({ orders });
  }

  async function getOrder(event, id) {
    const order = await readOrder(id);
    const q = event.queryStringParameters || {};
    const token = q.token || cleanText(event.headers?.['x-view-token'] || '', 200);
    if (!order) throw httpError(404, 'Order not found');
    const view = await viewOrder(order, token);
    if (!view) throw httpError(404, 'Order not found');
    return ok(view);
  }

  async function uploadProof(event, id) {
    const order = await readOrder(id);
    if (!order) throw httpError(404, 'Order not found');
    const body = parseJsonBody(event, 8 * 1024 * 1024);
    const { token, mimeType, fileName, buffer } = parseProofInput(body);
    if (!order.viewToken || token !== order.viewToken) {
      throw httpError(404, 'Order not found');
    }

    await writeBinary(proofs, `proof:${id}`, buffer);
    await store.set(`proof:meta:${id}`, {
      mimeType,
      fileName,
      size: buffer.byteLength,
      createdAt: new Date().toISOString(),
    });
    order.proofAt = new Date().toISOString();
    order.proofFileName = fileName;
    order.updatedAt = order.proofAt;
    await writeOrder(order);
    await audit('proof.uploaded', { id, size: buffer.byteLength, mimeType });

    return ok({ ok: true });
  }

  async function viewProof(event, id) {
    const order = await readOrder(id);
    if (!order) throw httpError(404, 'Order not found');
    const q = event.queryStringParameters || {};
    const token = q.token || cleanText(event.headers?.['x-view-token'] || '', 200);
    if (!order.viewToken || token !== order.viewToken) {
      throw httpError(404, 'Order not found');
    }
    const buffer = await readBinary(proofs, `proof:${id}`);
    const meta = await readJson(store, `proof:meta:${id}`);
    if (!buffer || !meta) throw httpError(404, 'Proof not found');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': meta.mimeType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(buffer.byteLength),
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  }

  /* ------------------------------------------------------------- admin API */

  function secretKey() {
    return String(getEnv('EXCHANGE_JWT_SECRET') || '');
  }

  function adminPasscode() {
    return String(getEnv('EXCHANGE_ADMIN_PASSWORD') || '');
  }

  function requireAdmin(event) {
    const secret = secretKey();
    if (!secret) throw httpError(503, 'Admin auth is not configured');
    const token = bearerToken(event);
    if (!token) throw httpError(401, 'Not authenticated');
    try {
      return verifyAccessToken(token, secret, { role: 'ADMIN' });
    } catch (err) {
      if (err instanceof TokenError) {
        const status = err.code === 'role' ? 403 : 401;
        throw httpError(status, err.message);
      }
      throw err;
    }
  }

  async function adminLogin(event) {
    if (limitLogin(clientIp(event))) {
      throw httpError(429, 'Too many attempts. Try again later.');
    }
    const secret = secretKey();
    const passcode = adminPasscode();
    if (!secret || !passcode) {
      console.error('exchange: admin auth not configured');
      throw httpError(503, 'Admin auth is not configured');
    }
    const body = parseJsonBody(event);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) throw httpError(400, 'password is required');

    if (!(await verifyPassword(password, passcode))) {
      await audit('admin.login.failed', {});
      throw httpError(401, 'Incorrect passcode');
    }

    const { sub } = { sub: 'admin' };
    const jti = await createRefreshSession(store, sub);
    const accessToken = signAccessToken({ sub, role: 'ADMIN' }, secret);
    await audit('admin.login', {});
    return ok(
      { ok: true, accessToken, role: 'ADMIN', expiresInSeconds: 15 * 60 },
      { 'Set-Cookie': refreshCookie(jti) },
    );
  }

  async function adminLogout(event) {
    requireAdmin(event);
    const jti = readRefreshJti(event);
    await deleteRefreshSession(store, jti);
    await audit('admin.logout', {});
    return ok({ ok: true }, { 'Set-Cookie': clearRefreshCookie() });
  }

  async function adminRefresh(event) {
    const secret = secretKey();
    if (!secret) throw httpError(503, 'Admin auth is not configured');
    const jti = readRefreshJti(event);
    if (!jti) throw httpError(401, 'No refresh session');
    const rotated = await rotateRefreshSession(store, jti, 'admin');
    if (!rotated) throw httpError(401, 'Refresh session is invalid or expired');
    const accessToken = signAccessToken({ sub: rotated.sub, role: 'ADMIN' }, secret);
    return ok(
      { ok: true, accessToken, role: 'ADMIN', expiresInSeconds: 15 * 60 },
      { 'Set-Cookie': refreshCookie(rotated.jti) },
    );
  }

  async function adminSession(event) {
    const payload = requireAdmin(event);
    return ok({ ok: true, sub: payload.sub, role: payload.role, iat: payload.iat, exp: payload.exp });
  }

  async function adminStats(event) {
    requireAdmin(event);
    const ids = await orderIds();
    const counts = { PENDING: 0, APPROVED: 0, COMPLETED: 0, REJECTED: 0 };
    let volume = 0;
    let pendingVolume = 0;
    for (const id of ids) {
      const order = await readOrder(id);
      if (!order) continue;
      counts[order.status] = (counts[order.status] || 0) + 1;
      if (isFiniteNumber(order.receiveAmount)) {
        volume += order.receiveAmount;
        if (order.status === 'PENDING') pendingVolume += order.receiveAmount;
      }
    }
    return ok({
      total: ids.length,
      counts,
      volume,
      pendingVolume,
      currency: 'MMK',
    });
  }

  async function adminOrders(event) {
    requireAdmin(event);
    const q = event.queryStringParameters || {};
    const status = q.status && ORDER_STATUSES.has(q.status) ? q.status : undefined;
    const page = parseInt(q.page || '1', 10);
    const perPage = parseInt(q.perPage || '25', 10);
    return ok(await adminOrdersPage({ status, q: q.q || '', page, perPage }));
  }

  async function adminOrder(event, id) {
    requireAdmin(event);
    const order = await readOrder(id);
    if (!order) throw httpError(404, 'Order not found');
    return ok({ ...fullOrder(order), viewToken: order.viewToken });
  }

  async function adminTransition(event, id, action) {
    requireAdmin(event);
    if (action === 'delete') {
      const existing = await readOrder(id);
      if (!existing) throw httpError(404, 'Order not found');
      await removeOrder(id);
      await audit('order.deleted', { id, fromStatus: existing.status });
      return ok({ ok: true, deleted: true });
    }

    // Blobs is eventually consistent, so a state just written can briefly read
    // back as its previous value. On a state conflict, re-read once after a
    // short delay to ride out the common sub-second window before giving up.
    for (let attempt = 0; ; attempt++) {
      const order = await readOrder(id);
      if (!order) throw httpError(404, 'Order not found');

      const fromStatus = order.status;
      let toStatus = fromStatus;
      if (action === 'approve' && fromStatus === 'PENDING') toStatus = 'APPROVED';
      else if (action === 'complete' && fromStatus === 'APPROVED') toStatus = 'COMPLETED';
      else if (action === 'reject' && (fromStatus === 'PENDING' || fromStatus === 'APPROVED')) toStatus = 'REJECTED';
      else {
        if (attempt === 0) {
          await sleep(250);
          continue;
        }
        throw httpError(400, `Cannot ${action} an order in state ${fromStatus}`);
      }

      order.status = toStatus;
      if (toStatus === 'COMPLETED') order.completedAt = new Date().toISOString();
      order.updatedAt = new Date().toISOString();
      await writeOrder(order);
      await audit(`order.${action}`, { id, fromStatus, toStatus });
      return ok(publicOrder(order));
    }
  }

  async function adminRates(event) {
    requireAdmin(event);
    if (event.httpMethod === 'GET') {
      const rate = await getRate();
      // New-key writes (rate:history:*) are readable immediately; listing the
      // prefix avoids the read-modify-write index that dropped entries live.
      const keys = (await store.list({ prefix: 'rate:history:' }))
        .map((entry) => entry.key)
        .sort()
        .reverse();
      const items = [];
      for (const key of keys.slice(0, 20)) {
        const entry = await readJson(store, key);
        if (entry) items.push(entry);
      }
      return ok({ ...rate, open: await getOpen(), history: items });
    }

    const body = parseJsonBody(event);
    if (body.open !== undefined && typeof body.open !== 'boolean') {
      throw httpError(400, 'open must be a boolean');
    }
    const hasRate = body.thbToMmk !== undefined;
    if (!hasRate && body.open === undefined) {
      throw httpError(400, 'Provide thbToMmk and/or open');
    }

    const result = {};
    if (hasRate) {
      let input;
      try {
        input = parseRateInput(body);
      } catch (err) {
        throw httpError(400, err.message);
      }
      const now = new Date().toISOString();
      const next = {
        thbToMmk: input.thbToMmk,
        mmkToThb: round4(1 / input.thbToMmk),
        updatedAt: now,
        source: 'admin',
      };
      await store.set('rate:current', next);
      // Append-only history: new key, listed by prefix when read back.
      await store.set(`rate:history:${Date.now()}:${randomBytes(3).toString('hex')}`, {
        ...next,
        actor: 'admin',
      });
      await audit('rate.updated', { thbToMmk: next.thbToMmk });
      result.thbToMmk = next.thbToMmk;
      result.mmkToThb = next.mmkToThb;
    }

    if (body.open !== undefined) {
      await store.set('setting:open', { open: body.open });
      await audit('exchange.state', { open: body.open });
      result.open = body.open;
    }

    return ok({ ok: true, ...result });
  }

  async function adminAudit(event) {
    requireAdmin(event);
    const q = event.queryStringParameters || {};
    const page = Math.max(1, parseInt(q.page || '1', 10));
    const perPage = 25;
    // Entries are append-only under audit:<ts>:<rand>, so the prefix listing
    // IS the index. audit:index was retired when read-modify-write indices
    // were dropped; the filter keeps any old rows inert if still present.
    const list = await store.list({ prefix: 'audit:' });
    const keys = list
      .map((item) => item.key)
      .filter((key) => key !== 'audit:index')
      .sort()
      .reverse();
    const rows = [];
    for (const key of keys.slice((page - 1) * perPage, page * perPage)) {
      const entry = await readJson(store, key);
      if (entry) rows.push({ key: key.split(':').slice(1).join(':'), ...entry });
    }
    return ok({ rows, page, perPage, totalKeys: keys.length });
  }

  /* ------------------------------------------------------------- dispatch */

  const exchangeRoutes = {
    'GET /api/exchange/rates': getRates,
    'POST /api/exchange/calculate': calculate,
    'POST /api/exchange/orders': createOrder,
    'POST /api/exchange/orders/list': listOrders,
  };

  async function route(event) {
    const method = (event.httpMethod || 'GET').toUpperCase();
    const path = pathOf(event);
    const parts = path.split('/').filter(Boolean);

    try {
      // Public exchange routes -------------------------------------------------
      const exact = `${method} /api/${parts.slice(1).join('/')}`;
      if (parts[0] === 'api' && parts[1] === 'exchange') {
        if (exchangeRoutes[exact]) return await exchangeRoutes[exact](event);

        if (parts[4] === 'proof' && parts.length === 5 && method === 'POST') {
          return await uploadProof(event, parts[3]);
        }
        if (parts[4] === 'proof' && parts.length === 5 && method === 'GET') {
          return await viewProof(event, parts[3]);
        }
        if (parts[2] === 'orders' && parts.length === 4) {
          if (method === 'GET') return await getOrder(event, parts[3]);
          throw httpError(405, 'Method not allowed');
        }

        throw httpError(404, 'Not found');
      }

      // Admin routes ------------------------------------------------------------
      if (parts[0] === 'api' && parts[1] === 'admin') {
        const seg = parts.slice(2);
        if (seg.length === 1 && seg[0] === 'login' && method === 'POST') return await adminLogin(event);
        if (seg.length === 1 && seg[0] === 'logout' && method === 'POST') return await adminLogout(event);
        if (seg.length === 1 && seg[0] === 'refresh' && method === 'POST') return await adminRefresh(event);
        if (seg.length === 1 && seg[0] === 'session' && method === 'GET') return await adminSession(event);
        if (seg.length === 1 && seg[0] === 'stats' && method === 'GET') return await adminStats(event);
        if (seg.length === 1 && seg[0] === 'orders' && method === 'GET') return await adminOrders(event);
        if (seg.length === 2 && seg[0] === 'orders' && method === 'GET') return await adminOrder(event, seg[1]);
        if (
          seg.length === 3 &&
          seg[0] === 'orders' &&
          method === 'POST' &&
          (seg[2] === 'approve' || seg[2] === 'reject' || seg[2] === 'complete' || seg[2] === 'delete')
        ) {
          return await adminTransition(event, seg[1], seg[2]);
        }
        if (seg.length === 1 && seg[0] === 'rates' && method === 'GET') return await adminRates(event);
        if (seg.length === 1 && seg[0] === 'rates' && method === 'POST') return await adminRates(event);
        if (seg.length === 1 && seg[0] === 'audit' && method === 'GET') return await adminAudit(event);

        throw httpError(404, 'Not found');
      }

      throw httpError(404, 'Not found');
    } catch (err) {
      if (err && err.status) return fail(err.status, err.message);
      if (err && err.code === 'TOO_LARGE') return fail(413, 'Request too large');
      if (err instanceof Error) {
        // Expected client-side input errors surface here; anything else is a bug.
        return fail(400, err.message);
      }
      console.error('exchange: unhandled error', err);
      return fail(500, 'Server error');
    }
  }

  return { route, viewOrder, publicOrder, getRate };
}

export const handler = async (event) => {
  const { store, proofs } = await openStores(event);
  const server = createServer({ store, proofs });
  return server.route(event);
};

/* Not a route: exported so tests can assert the honeypot behaviour without a
 * network round-trip. */
export const _internals = { hashOf: (v) => createHash('sha256').update(String(v)).digest('hex') };