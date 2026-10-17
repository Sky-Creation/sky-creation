/* Netlify Function: SCI Exchange - public surface only.
 *
 * The SITE-WIDE admin (login, users, posts, audit, and the exchange admin
 * screens) lives in functions/admin.mjs behind /api/admin/*. This function
 * serves the public /api/exchange/* storefront and nothing else, so a
 * compromised public endpoint can never touch admin auth code in the same
 * module. The order/rate/state code shared by both is in
 * exchange-lib/orders.mjs.
 *
 * Routes (same-origin, rewired in netlify.toml):
 *   GET  /api/exchange/rates
 *   POST /api/exchange/calculate
 *   POST /api/exchange/orders
 *   POST /api/exchange/orders/list
 *   GET  /api/exchange/orders/:id
 *   POST /api/exchange/orders/:id/proof          X-View-Token + JSON image body
 *   GET  /api/exchange/orders/:id/proof          X-View-Token
 *
 * Environment:
 *   EXCHANGE_RATE_DEFAULT     optional seed THB->MMK rate (default 128.5)
 *   RATE_LIMIT_HMAC_KEY       required in production (>= 32 chars)
 *   UPSTASH_REDIS_REST_URL    required in production (shared rate limiter)
 *   UPSTASH_REDIS_REST_TOKEN  required in production
 *   SKY_EXCHANGE_TEST=1       use in-memory stores + memory limiter (tests only)
 *
 * Security notes:
 *   - every amount is validated with Number.isFinite (JSON.parse("1e309")
 *     yields Infinity), positive and bounded;
 *   - recognised prototype-pollution keys are rejected before use;
 *   - order details are redacted publicly unless the caller holds the per-order
 *     viewToken via the X-View-Token header; tokens are 48 hex chars and are
 *     returned to the creator once;
 *   - the honeypot field ("company") is the only success-without-persistence
 *     path, matching the contact form.
 */

import { randomBytes } from 'node:crypto';

import { openStores, readJson, readBinary, writeBinary } from './exchange-lib/store.mjs';
import {
  cleanText,
  parseJsonBody,
  parseOrderInput,
  parseProofInput,
  assertSafeKeys,
  MAX_ORDER_AMOUNT,
  ValidationError,
} from './exchange-lib/validate.mjs';
import { json, ok, fail, httpError, clientIp, pathOf } from './exchange-lib/http.mjs';
import {
  createOrderStore,
  makeOrderId,
  makeReference,
  makeViewToken,
  quote,
  MINIMUMS,
} from './exchange-lib/orders.mjs';
import {
  createMemoryRateLimiter,
  createProductionRateLimiter,
  enforceRateLimit,
  resolveRateLimitHmacKey,
  RateLimiterError,
} from './exchange-lib/rate-limit.mjs';

export { InMemoryStore } from './exchange-lib/store.mjs';

const LEVELS = ['Standard', 'Express', 'VIP'].map((id) => ({ id, name: id }));

let productionLimiterPromise;

/* ----------------------------------------------------------------- server */

export function createServer({ store, proofs, admin, env = {}, limiter, limiterFactory } = {}) {
  // admin stores the unified audit log in production; tests that predate the
  // split still get a store they can assert against.
  const svc = createOrderStore({
    store,
    proofs,
    auditStore: admin || store,
    env,
  });
  const getEnv = (name) => {
    const override = env[name];
    return override !== undefined ? override : process.env[name];
  };

  // Injected limiter / no factory = in-process test path; production always
  // passes limiterFactory and requires RATE_LIMIT_HMAC_KEY.
  const allowTestDefault =
    Boolean(limiter) || !limiterFactory || String(getEnv('SKY_EXCHANGE_TEST') || '') === '1';
  const rateLimitKey = resolveRateLimitHmacKey(
    { RATE_LIMIT_HMAC_KEY: getEnv('RATE_LIMIT_HMAC_KEY') },
    { allowTestDefault },
  );

  let orderLimiter = limiter || (limiterFactory ? null : createMemoryRateLimiter());

  async function getOrderLimiter() {
    if (limiterFactory && !orderLimiter) orderLimiter = await limiterFactory();
    return orderLimiter;
  }

  /* ------------------------------------------------------------ public API */

  async function getRates() {
    const [rate, open, channels] = await Promise.all([svc.getRate(), svc.getOpen(), svc.getChannels()]);
    return ok({
      open,
      thbToMmk: rate.thbToMmk,
      mmkToThb: rate.mmkToThb,
      updatedAt: rate.updatedAt,
      source: rate.source,
      minimums: MINIMUMS,
      levels: LEVELS,
      channels,
    });
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
    const rate = await svc.getRate();
    if ((await svc.getOpen()) === false) {
      throw httpError(503, 'The exchange is currently closed');
    }
    const result = quote(amount, direction, rate.thbToMmk);
    return ok({ direction, amount, ...result, minimums: MINIMUMS });
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  async function createOrder(event) {
    await enforceRateLimit({
      limiter: await getOrderLimiter(),
      namespace: 'exchange-order-create',
      ip: clientIp(event),
      max: 10,
      windowSeconds: 10 * 60,
      hmacKey: rateLimitKey,
    });

    const body = parseJsonBody(event);
    assertSafeKeys(body, 'body');

    // Honeypot mirrors the contact form: a filled hidden field means a bot.
    // Report success and persist nothing, so the bot cannot tell.
    if (cleanText(body.company, 200)) {
      console.log('exchange: honeypot triggered, order discarded');
      return ok({ ok: true, discarded: true });
    }

    if ((await svc.getOpen()) === false) {
      throw httpError(503, 'The exchange is currently closed');
    }

    const input = parseOrderInput(body);
    const min = input.direction === 'THB_TO_MMK' ? MINIMUMS.THB : MINIMUMS.MMK;
    if (input.amount < min) {
      throw httpError(400, `amount is below the minimum of ${min}`);
    }

    const rate = await svc.getRate();
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

    await svc.writeOrder(order);
    await svc.audit('order.created', { id, reference: order.reference, direction: order.direction });

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
      const order = await svc.readOrder(entry.id);
      // The list route intentionally does not accept view tokens. It is used
      // for a guest's local history, which only needs status-only cards.
      orders.push(await svc.viewOrder(order, ''));
    }
    return ok({ orders });
  }

  async function getOrder(event, id) {
    const order = await svc.readOrder(id);
    const token = cleanText(event.headers?.['x-view-token'] || '', 200);
    if (!order) throw httpError(404, 'Order not found');
    const view = await svc.viewOrder(order, token);
    if (!view) throw httpError(404, 'Order not found');
    return ok(view);
  }

  async function uploadProof(event, id) {
    const order = await svc.readOrder(id);
    if (!order) throw httpError(404, 'Order not found');
    const token = cleanText(event.headers?.['x-view-token'] || '', 200);
    if (!order.viewToken || token !== order.viewToken) {
      throw httpError(404, 'Order not found');
    }
    if (order.status !== 'PENDING') {
      throw httpError(400, 'Proof can only be uploaded while the order is pending');
    }
    const body = parseJsonBody(event, 8 * 1024 * 1024);
    const { mimeType, fileName, buffer } = parseProofInput(body);

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
    await svc.writeOrder(order);
    await svc.audit('proof.uploaded', { id, size: buffer.byteLength, mimeType });

    return ok({ ok: true });
  }

  async function viewProof(event, id) {
    const order = await svc.readOrder(id);
    if (!order) throw httpError(404, 'Order not found');
    const token = cleanText(event.headers?.['x-view-token'] || '', 200);
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
      console.error('exchange: unhandled error', err && err.stack ? err.stack : err);
      return fail(500, 'Server error');
    }
  }

  return { route, viewOrder: svc.viewOrder, publicOrder: svc.publicOrder, getRate: svc.getRate };
}

export const handler = async (event) => {
  try {
    const { store, proofs, admin } = await openStores(event);
    const testMode = process.env.SKY_EXCHANGE_TEST === '1';
    if (!testMode) {
      productionLimiterPromise = productionLimiterPromise || createProductionRateLimiter(process.env);
    }
    const server = createServer({
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
    console.error('exchange: unavailable', err && err.message ? err.message : err);
    return fail(503, 'Service temporarily unavailable');
  }
};
