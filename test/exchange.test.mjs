/* Tests for the SCI Exchange function: public order lifecycle and proof upload.
 *
 * The SITE-WIDE admin (login, posts, audit, and the exchange admin screens)
 * now lives in functions/admin.mjs behind /api/admin/*; its tests are in
 * admin.test.mjs. The few public tests here that need an admin-like state
 * (exchange closed, a rate set) drive the shared createOrderStore directly
 * against the same in-memory stores, which is exactly what the admin function
 * does over HTTP.
 *
 * The server is run with in-memory stores so no @netlify/blobs package is
 * needed and every case starts clean. The tests enforce the same security
 * rules as the reference app's adversarial suite: amounts arrive as real
 * finite numbers, prototype-pollution keys are rejected, order details are
 * redacted unless the caller holds the view token, and the honeypot is the
 * only success-without-persistence path.
 *
 * Run: node --test test/*.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createServer, InMemoryStore } from '../functions/exchange.mjs';
import { createOrderStore } from '../functions/exchange-lib/orders.mjs';
import { JsonStore, readJson, readBinary } from '../functions/exchange-lib/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const m = join(here);

const ENV = { EXCHANGE_JWT_SECRET: 'test-secret' };

function newServer() {
  const store = new InMemoryStore();
  const proofs = new InMemoryStore();
  return {
    server: createServer({ store, proofs, env: ENV }),
    store,
    proofs,
    svc: createOrderStore({ store, proofs, auditStore: store, env: ENV }),
  };
}

function makeEvent({ method = 'GET', path = '/api/exchange/rates', body, ip = '203.0.113.9', query } = {}) {
  const [cleanPath, rawQuery] = String(path).split('?');
  const qs = query || Object.fromEntries(new URLSearchParams(rawQuery || '').entries());
  return {
    httpMethod: method,
    path: cleanPath,
    queryStringParameters: qs,
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    headers: { 'x-nf-client-connection-ip': ip },
  };
}

test('the module exposes a server factory and handler', async () => {
  const { server } = newServer();
  assert.ok(server, 'expected createServer to return a server');
  const mod = await import(`../functions/exchange.mjs?export=${Date.now()}`);
  assert.equal(typeof mod.handler, 'function');
  assert.equal(typeof mod.createServer, 'function');
});

// ------------------------------------------------------------------ rates

test('GET rates returns an open state and a positive rate by default', async () => {
  const { server } = newServer();
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
  const store = new InMemoryStore();
  const proofs = new InMemoryStore();
  const server = createServer({
    store,
    proofs,
    env: { ...ENV, EXCHANGE_RATE_DEFAULT: '140.25' },
  });
  const res = await server.route(makeEvent());
  assert.equal(JSON.parse(res.body).thbToMmk, 140.25);
});

test('a stored rate is what the public API returns', async () => {
  const { server, svc } = newServer();
  await svc.ratesApply({ thbToMmk: 131 }, 'admin');
  const res = await server.route(makeEvent());
  assert.equal(JSON.parse(res.body).thbToMmk, 131);
});

test('the exchange can be closed and the public API honours it', async () => {
  const { server, svc } = newServer();
  await svc.ratesApply({ open: false }, 'admin');
  const res = await server.route(makeEvent());
  assert.equal(JSON.parse(res.body).open, false);
});

// --------------------------------------------------------------- calculate

test('calculate converts THB to MMK and MMK to THB', async () => {
  const { server } = newServer();
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
  const { server } = newServer();
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
  const { server } = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: '{ "direction": "THB_TO_MMK", "amount": 1e309 }' })
  );
  assert.equal(res.statusCode, 400);
});

test('calculate rejects an amount passed as a string', async () => {
  const { server } = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: { direction: 'THB_TO_MMK', amount: '5000' } })
  );
  assert.equal(res.statusCode, 400);
});

test('calculate refuses to quote while the exchange is closed', async () => {
  const { server, svc } = newServer();
  await svc.ratesApply({ open: false }, 'admin');
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/calculate', body: { direction: 'THB_TO_MMK', amount: 5000 } })
  );
  assert.equal(res.statusCode, 503);
});

test('creating an order while the exchange is closed is refused', async () => {
  const { server, svc } = newServer();
  await svc.ratesApply({ open: false }, 'admin');
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() })
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
  const { server } = newServer();
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
  const { server } = newServer();
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
  const { server } = newServer();
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
  const { server } = newServer();
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
  const { server } = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody({ amount: 50 }) })
  );
  assert.equal(res.statusCode, 400);
});

test('the honeypot is the only success-without-persistence path', async () => {
  const { server, store } = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody({ company: 'Bot Corp' }) })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).discarded, true, 'the bot is told it worked');

  const rows = await store.list({ prefix: 'order:' });
  assert.equal(rows.length, 0, 'nothing was persisted');
});

// Reusing the honeypot contract from the contact form: a filled hidden field
// must be forwarded to the server unchanged, so it can filter on it. Dropping
// it client-side would silently lose real enquiries that autofill mis-files.
test('prototype-pollution keys in a request body are rejected', async () => {
  const { server } = newServer();
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
  const { server } = newServer();
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
  const { server } = newServer();
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/exchange/orders', body: '{not json' })
  );
  assert.equal(res.statusCode, 400);
});

test('repeated order creations from one IP are rate limited', async () => {
  const { server } = newServer();
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
  const { server } = newServer();
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
  const { server } = newServer();
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
  const { server } = newServer();
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

test('the blob wrapper parses JSON text instead of leaking it as a string', async () => {
  // Regression: the first live deploy read every order as JSON *text*, so
  // order.viewToken was undefined and the redaction never lifted even with the
  // right token. JsonStore must hide the raw store's text-returning surface.
  const raw = {
    async get(key, { type } = {}) {
      // Mirrors @netlify/blobs: a bare get() returns JSON *text* (the bug);
      // only an explicit reading type parses or returns bytes.
      if (type === 'arrayBuffer') return Buffer.from('raw-bytes');
      if (type === 'json') return { viewToken: 'abc', amount: 5 };
      return '{"viewToken":"abc","amount":5}';
    },
    async set(key) {
      return { key };
    },
    async delete() {},
    async list() {
      // Mirrors @netlify/blobs: an object with a blobs array, not the plain
      // array JsonStore promises.
      return {
        blobs: [
          { key: 'audit:x', etag: '"1"' },
          { key: 'audit:y', etag: '"2"' },
        ],
        directories: [],
      };
    },
  };
  const store = new JsonStore(raw);
  const value = await readJson(store, 'order:x');
  assert.equal(value.viewToken, 'abc', 'readJson returns a parsed object, not a string');
  assert.deepEqual(value, { viewToken: 'abc', amount: 5 });

  const bytes = await readBinary(store, 'proof:x');
  assert.equal(bytes.toString('utf8'), 'raw-bytes');

  const list = await store.list({ prefix: 'audit:' });
  assert.deepEqual(
    list.map((item) => item.key),
    ['audit:x', 'audit:y'],
    'JsonStore.list normalises the raw { blobs, directories } shape to an array',
  );
});