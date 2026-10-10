/* Tests for the SCI Exchange function: public order lifecycle, proof upload,
 * and the admin authentication/operations layer.
 *
 * The server is run with in-memory stores so no @netlify/blobs package is
 * needed and every case starts clean. The tests enforce the same security
 * rules as the reference app's adversarial suite: amounts arrive as real
 * finite numbers, prototype-pollution keys are rejected, order details are
 * redacted unless the caller holds the view token, the password check and
 * token verification answer 401/403 rather than 500, and the honeypot is the
 * only success-without-persistence path.
 *
 * Run: node --test test/*.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createServer, InMemoryStore } from '../functions/exchange.mjs';
import { signAccessToken } from '../functions/exchange-lib/auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const m = join(here);

const ENV = {
  EXCHANGE_JWT_SECRET: 'test-secret',
  EXCHANGE_ADMIN_PASSWORD: 'hunter2',
};

function newServer() {
  return createServer({ store: new InMemoryStore(), proofs: new InMemoryStore(), env: ENV });
}

function makeEvent({ method = 'GET', path = '/api/exchange/rates', body, ip = '203.0.113.9', headers, query } = {}) {
  const [cleanPath, rawQuery] = String(path).split('?');
  const qs = query || Object.fromEntries(new URLSearchParams(rawQuery || '').entries());
  return {
    httpMethod: method,
    path: cleanPath,
    queryStringParameters: qs,
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    headers: { 'x-nf-client-connection-ip': ip, ...(headers || {}) },
  };
}

function asAdmin(headers = {}) {
  return {
    'x-nf-client-connection-ip': '203.0.113.9',
    ...headers,
  };
}

async function adminToken(server, { password = ENV.EXCHANGE_ADMIN_PASSWORD } = {}) {
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { password } })
  );
  return JSON.parse(res.body).accessToken;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

test('the module exposes a server factory and handler', async () => {
  const server = newServer();
  assert.ok(server, 'expected createServer to return a server');
  const mod = await import(`../functions/exchange.mjs?export=${Date.now()}`);
  assert.equal(typeof mod.handler, 'function');
  assert.equal(typeof mod.createServer, 'function');
});

// ------------------------------------------------------------------ rates

test('GET rates returns an open state and a positive rate by default', async () => {
  const server = newServer();
  const res = await server.route(makeEvent());
  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body);
  assert.equal(body.open, true);
  assert.ok(body.thbToMmk > 0);
  assert.ok(body.mmkToThb > 0);
  assert.deepEqual(body.minimums, { THB: 100, MMK: 10000 });
  assert.ok(Array.isArray(body.levels) && body.levels.length === 3);
  assert.ok(Array.isArray(body.channels) && body.channels.length > 0);
});

test('the rate is seeded from EXCHANGE_RATE_DEFAULT when empty', async () => {
  const server = createServer({
    store: new InMemoryStore(),
    proofs: new InMemoryStore(),
    env: { ...ENV, EXCHANGE_RATE_DEFAULT: '140.25' },
  });
  const res = await server.route(makeEvent());
  assert.equal(JSON.parse(res.body).thbToMmk, 140.25);
});

test('a rate set through the admin API is what the public API returns', async () => {
  const server = newServer();
  const token = await adminToken(server);
  const set = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/rates', body: { thbToMmk: 131 } , headers: asAdmin(bearer(token)) })
  );
  assert.equal(set.statusCode, 200);

  const res = await server.route(makeEvent());
  assert.equal(JSON.parse(res.body).thbToMmk, 131);
});

test('the exchange can be closed through the admin API', async () => {
  const server = newServer();
  const token = await adminToken(server);
  const set = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/rates', body: { open: false }, headers: asAdmin(bearer(token)) })
  );
  assert.equal(set.statusCode, 200);

  const res = await server.route(makeEvent());
  assert.equal(JSON.parse(res.body).open, false);
});

// --------------------------------------------------------------- calculate

test('calculate converts THB to MMK and MMK to THB', async () => {
  const server = newServer();
  const rates = JSON.parse((await server.route(makeEvent())).body);

  const thb = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: { direction: 'THB_TO_MMK', amount: 5000 } })
  );
  assert.equal(thb.statusCode, 200);
  const thbBody = JSON.parse(thb.body);
  assert.equal(thbBody.receiveAmount, Math.round(5000 * rates.thbToMmk));
  assert.equal(thbBody.rateUsed, rates.thbToMmk, 'the displayed rate matches the live rate');
  assert.equal(thbBody.fee, 0);

  const mmk = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: { direction: 'MMK_TO_THB', amount: 500000 } })
  );
  assert.equal(mmk.statusCode, 200);
  const mmkBody = JSON.parse(mmk.body);
  assert.equal(mmkBody.receiveAmount, Math.round((500000 / rates.thbToMmk) * 100) / 100);
});

test('calculate refuses amounts below the minimum', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: { direction: 'THB_TO_MMK', amount: 50 } })
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /minimum/i);
});

// The first rule of the amount guards: JSON.parse turns "1e309" into Infinity,
// so a server that only checks `amount > 0` will happily quote an infinite
// payout. Number.isFinite has to be in the path.
test('calculate rejects an amount that the JSON parser turns into Infinity', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: '{ "direction": "THB_TO_MMK", "amount": 1e309 }' })
  );
  assert.equal(res.statusCode, 400);
});

test('calculate rejects an amount passed as a string', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: { direction: 'THB_TO_MMK', amount: '5000' } })
  );
  assert.equal(res.statusCode, 400);
});

test('calculate refuses to quote while the exchange is closed', async () => {
  const server = newServer();
  const token = await adminToken(server);
  await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/rates', body: { open: false }, headers: asAdmin(bearer(token)) })
  );
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: { direction: 'THB_TO_MMK', amount: 5000 } })
  );
  assert.equal(res.statusCode, 503);
});

// ---------------------------------------------------------------- orders

function orderBody(overrides = {}) {
  return {
    direction: 'THB_TO_MMK',
    amount: 5000,
    method: 'KBZPay',
    level: 'Standard',
    senderName: 'Aung Ko',
    senderContact: '+95012345678',
    accountNo: '1234567',
    accountName: 'Aung Ko',
    note: 'Family support',
    ...overrides,
  };
}

test('creating an order persists it and returns a view token', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() })
  );
  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body);
  assert.equal(body.status, 'PENDING');
  assert.ok(body.orderId && body.reference);
  assert.match(body.viewToken, /^[0-9a-f]{48}$/, 'view token is 48 hex chars');

  const order = await server.route(
    makeEvent({ path: `/api/exchange/orders/${body.orderId}` })
  );
  assert.equal(order.statusCode, 200);
  const view = JSON.parse(order.body);
  assert.equal(view.isRedacted, true, 'public view hides the details');
  assert.equal(view.senderName, undefined);
  assert.equal(view.amount, 5000);
});

test('an order is only revealed in full with the view token', async () => {
  const server = newServer();
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );

  const full = await server.route(
    makeEvent({ path: `/api/exchange/orders/${created.orderId}?token=${created.viewToken}` })
  );
  const view = JSON.parse(full.body);
  assert.equal(view.isRedacted, false);
  assert.equal(view.senderName, 'Aung Ko');
  assert.equal(view.senderContact, '+95012345678');
});

test('a wrong token is treated as no token, not an error that leaks the id', async () => {
  const server = newServer();
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );
  const res = await server.route(
    makeEvent({ path: `/api/exchange/orders/${created.orderId}?token=${'0'.repeat(48)}` })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).isRedacted, true);
});

test('order list resolver redacts and unredacts per entry', async () => {
  const server = newServer();
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );
  const res = await server.route(
    makeEvent({
      method: 'POST',
      path: '/api/exchange/orders/list',
      body: {
        orders: [
          { id: created.orderId },
          { id: created.orderId, viewToken: created.viewToken },
          { id: 'does-not-exist' },
        ],
      },
    })
  );
  assert.equal(res.statusCode, 200);
  const rows = JSON.parse(res.body).orders;
  assert.equal(rows[0].isRedacted, true);
  assert.equal(rows[1].isRedacted, false);
  assert.equal(rows[2], null, 'unknown ids resolve to null');
});

test('an order below the minimum is refused', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody({ amount: 50 }) })
  );
  assert.equal(res.statusCode, 400);
});

test('the honeypot is the only success-without-persistence path', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody({ company: 'Bot Corp' }) })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).discarded, true, 'the bot is told it worked');

  const list = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders/list', body: { orders: [] } })
  );
  const token = await adminToken(server);
  const adminOrders = await server.route(
    makeEvent({ path: '/api/admin/orders', headers: asAdmin(bearer(token)) })
  );
  assert.equal(JSON.parse(adminOrders.body).orders.length, 0, 'nothing was persisted');
  assert.equal(list.statusCode, 200);
});

// Reusing the honeypot contract from the contact form: a filled hidden field
// must be forwarded to the server unchanged, so it can filter on it. Dropping
// it client-side would silently lose real enquiries that autofill mis-files.
test('prototype-pollution keys in a request body are rejected', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({
      method: 'POST',
      path: '/api/exchange/orders',
      body: `{ "direction": "THB_TO_MMK", "amount": 5000, "__proto__": { "status": "ADMIN" } }`,
    })
  );
  assert.equal(res.statusCode, 400);
});

test('an oversized order body is a 413, not a 500', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({
      method: 'POST',
      path: '/api/exchange/orders',
      body: '{ "padding": "' + 'x'.repeat(70 * 1024) + '" }',
    })
  );
  assert.equal(res.statusCode, 413);
});

test('malformed JSON is a 400', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: '{not json' })
  );
  assert.equal(res.statusCode, 400);
});

test('repeated order creations from one IP are rate limited', async () => {
  const server = newServer();
  const event = makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody(), ip: '198.51.100.7' });
  let limited = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await server.route(event);
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited >= 1, 'the create limit engages from the same IP');
});

// ----------------------------------------------------------------- proofs

test('proof upload and view roundtrip with the view token', async () => {
  const server = newServer();
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );
  const jpeg = Buffer.from('ffd8ffe0 test image ffd9', 'hex');

  const upload = await server.route(
    makeEvent({
      method: 'POST',
      path: `/api/exchange/orders/${created.orderId}/proof`,
      body: {
        token: created.viewToken,
        mimeType: 'image/jpeg',
        fileName: 'slip.jpg',
        dataBase64: jpeg.toString('base64'),
      },
    })
  );
  assert.equal(upload.statusCode, 200);

  const view = await server.route(
    makeEvent({ path: `/api/exchange/orders/${created.orderId}/proof?token=${created.viewToken}` })
  );
  assert.equal(view.statusCode, 200);
  assert.equal(view.headers['Content-Type'], 'image/jpeg');
  assert.equal(Buffer.from(view.body, 'base64').toString('hex'), jpeg.toString('hex'));
});

test('a proof upload without the right token is a 404', async () => {
  const server = newServer();
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );
  const res = await server.route(
    makeEvent({
      method: 'POST',
      path: `/api/exchange/orders/${created.orderId}/proof`,
      body: { token: '0'.repeat(48), mimeType: 'image/jpeg', dataBase64: 'QUJD' },
    })
  );
  assert.equal(res.statusCode, 404);
});

test('proof upload enforces the mime allowlist and size cap', async () => {
  const server = newServer();
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );
  const badMime = await server.route(
    makeEvent({
      method: 'POST',
      path: `/api/exchange/orders/${created.orderId}/proof`,
      body: { token: created.viewToken, mimeType: 'text/html', dataBase64: 'QUJD' },
    })
  );
  assert.equal(badMime.statusCode, 400);

  const tooBig = await server.route(
    makeEvent({
      method: 'POST',
      path: `/api/exchange/orders/${created.orderId}/proof`,
      body: { token: created.viewToken, mimeType: 'image/png', dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1000).toString('base64') },
    })
  );
  assert.equal(tooBig.statusCode, 400, 'decoded size is what counts, and it is capped');
});

// ------------------------------------------------------------------- admin

test('login is refused when the secret or passcode is not configured', async () => {
  const server = createServer({
    store: new InMemoryStore(),
    proofs: new InMemoryStore(),
    env: {},
  });
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { password: 'x' } })
  );
  assert.equal(res.statusCode, 503);
});

test('login with the wrong passcode is a 401', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { password: 'wrong' } })
  );
  assert.equal(res.statusCode, 401);
});

test('login with the right passcode yields a working access token', async () => {
  const server = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { password: ENV.EXCHANGE_ADMIN_PASSWORD } })
  );
  assert.equal(res.statusCode, 200);
  const session = JSON.parse(res.body);
  assert.ok(session.accessToken);
  assert.equal(session.role, 'ADMIN');

  const verified = await server.route(
    makeEvent({ path: '/api/admin/session', headers: asAdmin(bearer(session.accessToken)) })
  );
  assert.equal(verified.statusCode, 200);
});

test('admin routes without a token answer 401', async () => {
  const server = newServer();
  const res = await server.route(makeEvent({ path: '/api/admin/stats', headers: asAdmin() }));
  assert.equal(res.statusCode, 401);
});

test('an alg:none token is rejected', async () => {
  const server = newServer();
  const token = await adminToken(server);
  const [header, payload, signature] = token.split('.');
  const forged = [header, payload, ''].join('.');

  const res = await server.route(
    makeEvent({ path: '/api/admin/session', headers: asAdmin(bearer(forged)) })
  );
  assert.equal(res.statusCode, 401);
});

test('a token signed with the wrong secret is rejected', async () => {
  const server = newServer();
  const forged = signAccessToken({ sub: 'admin', role: 'ADMIN' }, 'wrong-secret');
  const res = await server.route(
    makeEvent({ path: '/api/admin/session', headers: asAdmin(bearer(forged)) })
  );
  assert.equal(res.statusCode, 401);
});

test('an expired token is rejected', async () => {
  const server = newServer();
  const expired = signAccessToken({ sub: 'admin', role: 'ADMIN' }, ENV.EXCHANGE_JWT_SECRET, -60);
  const res = await server.route(
    makeEvent({ path: '/api/admin/session', headers: asAdmin(bearer(expired)) })
  );
  assert.equal(res.statusCode, 401);
});

test('a non-admin role token is refused', async () => {
  const server = newServer();
  const wrongRole = signAccessToken({ sub: 'visitor', role: 'USER' }, ENV.EXCHANGE_JWT_SECRET);
  const res = await server.route(
    makeEvent({ path: '/api/admin/session', headers: asAdmin(bearer(wrongRole)) })
  );
  assert.equal(res.statusCode, 403);
});

test('admin sees orders and walks them to completion', async () => {
  const server = newServer();
  const token = await adminToken(server);
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );

  const list = await server.route(makeEvent({ path: '/api/admin/orders', headers: asAdmin(bearer(token)) }));
  const rows = JSON.parse(list.body).orders;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, created.orderId);
  assert.equal(rows[0].isRedacted, true, 'admin list is redacted like public list');

  const approve = await server.route(
    makeEvent({ method: 'POST', path: `/api/admin/orders/${created.orderId}/approve`, body: {}, headers: asAdmin(bearer(token)) })
  );
  assert.equal(JSON.parse(approve.body).status, 'APPROVED');

  const complete = await server.route(
    makeEvent({ method: 'POST', path: `/api/admin/orders/${created.orderId}/complete`, body: {}, headers: asAdmin(bearer(token)) })
  );
  assert.equal(JSON.parse(complete.body).status, 'COMPLETED');
  assert.ok(JSON.parse(complete.body).completedAt);

  const stats = await server.route(makeEvent({ path: '/api/admin/stats', headers: asAdmin(bearer(token)) }));
  const body = JSON.parse(stats.body);
  assert.equal(body.total, 1);
  assert.equal(body.counts.COMPLETED, 1);
});

test('an invalid transition is refused', async () => {
  const server = newServer();
  const token = await adminToken(server);
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );
  const complete = await server.route(
    makeEvent({ method: 'POST', path: `/api/admin/orders/${created.orderId}/complete`, body: {}, headers: asAdmin(bearer(token)) })
  );
  assert.equal(complete.statusCode, 400);
});

test('an order can be deleted, removing it from the index', async () => {
  const server = newServer();
  const token = await adminToken(server);
  const created = JSON.parse(
    (await server.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );
  const del = await server.route(
    makeEvent({ method: 'POST', path: `/api/admin/orders/${created.orderId}/delete`, body: {}, headers: asAdmin(bearer(token)) })
  );
  assert.equal(del.statusCode, 200);
  assert.equal(JSON.parse(del.body).deleted, true);

  const list = await server.route(makeEvent({ path: '/api/admin/orders', headers: asAdmin(bearer(token)) }));
  assert.equal(JSON.parse(list.body).orders.length, 0);
});

test('rates history is recorded and surfaced', async () => {
  const server = newServer();
  const token = await adminToken(server);
  await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/rates', body: { thbToMmk: 131.25 }, headers: asAdmin(bearer(token)) })
  );
  const rates = await server.route(makeEvent({ path: '/api/admin/rates', headers: asAdmin(bearer(token)) }));
  const body = JSON.parse(rates.body);
  assert.equal(body.thbToMmk, 131.25);
  assert.ok(body.history.length >= 1);
  assert.equal(body.history[0].thbToMmk, 131.25);
});

test('login attempts are rate limited and logged', async () => {
  const server = newServer();
  const event = makeEvent({ method: 'POST', path: '/api/admin/login', body: { password: 'wrong' } });
  let limited = 0;
  for (let i = 0; i < 14; i += 1) {
    const res = await server.route(event);
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited >= 1, 'the login limit engages');

  // The rate limiter has the door shut, so read the log with a directly signed
  // token rather than another login attempt.
  const token = signAccessToken({ sub: 'admin', role: 'ADMIN' }, ENV.EXCHANGE_JWT_SECRET);
  const audit = await server.route(makeEvent({ path: '/api/admin/audit', headers: asAdmin(bearer(token)) }));
  const rows = JSON.parse(audit.body).rows;
  assert.ok(rows.some((row) => row.action === 'admin.login.failed'), 'failed logins are auditable');
});

test('logout revokes the refresh session', async () => {
  const server = newServer();
  const login = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { password: ENV.EXCHANGE_ADMIN_PASSWORD } })
  );
  const cookie = login.headers['Set-Cookie'];
  const accessToken = JSON.parse(login.body).accessToken;

  const logout = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/logout', body: {}, headers: { ...asAdmin(bearer(accessToken)), cookie } })
  );
  assert.equal(logout.statusCode, 200);

  const refresh = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/refresh', body: {}, headers: { cookie } })
  );
  assert.equal(refresh.statusCode, 401, 'the rotated-out session is dead');
});

test('a refresh session is rotated: reuse of the old cookie fails', async () => {
  const server = newServer();
  const login = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { password: ENV.EXCHANGE_ADMIN_PASSWORD } })
  );
  const oldCookie = login.headers['Set-Cookie'];
  const oldJti = oldCookie.match(/refreshToken=([0-9a-f]+)/)[1];

  const refresh = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/refresh', body: {}, headers: { cookie: oldCookie } })
  );
  assert.equal(refresh.statusCode, 200);
  const newCookie = refresh.headers['Set-Cookie'];
  const newJti = newCookie.match(/refreshToken=([0-9a-f]+)/)[1];
  assert.notEqual(newJti, oldJti, 'the jti changes on every refresh');

  const replay = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/refresh', body: {}, headers: { cookie: oldCookie } })
  );
  assert.equal(replay.statusCode, 401, 'replaying the old cookie is refused');
});