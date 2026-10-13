/* Tests for the site-wide admin function (functions/admin.mjs).
 *
 * The admin is a separate same-origin function from the public exchange: it
 * owns /api/admin/* and the public /api/posts lists. Login is username/email +
 * password against a seeded per-user scrypt hash in the SCI_ADMIN store,
 * sessions are rotating httpOnly refresh cookies, and every write is audited
 * into the same store.
 *
 * The store for the admin's exchange module is the SAME shared store the
 * public function writes to; tests create orders through the public exchange
 * server over that store, exactly like production.
 *
 * Run: node --test test/*.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createServer, InMemoryStore } from '../functions/exchange.mjs';
import { createAdminServer } from '../functions/admin.mjs';
import { scryptHash, signAccessToken } from '../functions/exchange-lib/auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const m = join(here);

const ENV = {
  EXCHANGE_JWT_SECRET: 'test-secret',
  // Only used as the seed input at bootstrap; verifyStoredHash never sees it.
  EXCHANGE_ADMIN_PASSWORD: 'seed-only',
};

const PASS = 'hunter2';
const EMAIL = 'contact@skycreation.dev';
const USERNAME = 'admin';

function makeEvent({ method = 'GET', path = '/api/admin/dashboard', body, ip = '203.0.113.9', headers } = {}) {
  return {
    httpMethod: method,
    path,
    queryStringParameters: {},
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    headers: { 'x-nf-client-connection-ip': ip, ...(headers || {}) },
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function seedUser(admin, userPw = PASS) {
  const { saltHex, hashHex } = await scryptHash(userPw);
  await admin.set('user:primary', {
    id: 'primary',
    username: USERNAME,
    email: EMAIL,
    name: 'Site Admin',
    role: 'ADMIN',
    saltHex,
    hashHex,
    createdAt: new Date().toISOString(),
  });
}

async function newAdmin() {
  const store = new InMemoryStore();
  const proofs = new InMemoryStore();
  const admin = new InMemoryStore();
  await seedUser(admin);
  const server = createAdminServer({ store, proofs, admin, env: ENV });
  // The public storefront over the same stores, so admin-order integration
  // tests go through the real public path.
  const publicServer = createServer({ store, proofs, admin, env: ENV });
  return { server, publicServer, store, proofs, admin };
}

async function login(ctx, { identifier = EMAIL, password = PASS, ip } = {}) {
  return ctx.server.route(
    makeEvent({
      method: 'POST',
      path: '/api/admin/login',
      body: { identifier, password },
      ip,
    })
  );
}

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

assert.ok(m, 'module path is referenced');

// ------------------------------------------------------------------ login

test('login is refused when the JWT secret is not configured', async () => {
  const store = new InMemoryStore();
  const proofs = new InMemoryStore();
  const admin = new InMemoryStore();
  await seedUser(admin);
  const server = createAdminServer({ store, proofs, admin, env: {} });
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { identifier: EMAIL, password: PASS } })
  );
  assert.equal(res.statusCode, 503);
});

test('login is refused when no admin user is seeded', async () => {
  const store = new InMemoryStore();
  const proofs = new InMemoryStore();
  const admin = new InMemoryStore();
  const server = createAdminServer({ store, proofs, admin, env: ENV });
  const res = await server.route(
    makeEvent({ method: 'POST', path: '/api/admin/login', body: { identifier: EMAIL, password: PASS } })
  );
  assert.equal(res.statusCode, 503);
});

test('a wrong identifier and a wrong password answer the same', async () => {
  const ctx = await newAdmin();
  const badIdentifier = await login(ctx, { identifier: 'nobody@example.com' });
  const badPassword = await login(ctx, { password: 'wrong-password' });
  assert.equal(badIdentifier.statusCode, 401);
  assert.equal(badPassword.statusCode, 401);
  assert.equal(badIdentifier.body, badPassword.body, 'no user-enumeration oracle');
});

test('login with the correct email yields a token and a refresh cookie', async () => {
  const ctx = await newAdmin();
  const res = await login(ctx);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.accessToken);
  assert.equal(body.role, 'ADMIN');
  assert.equal(body.expiresInSeconds, 900);
  assert.match(res.headers['Set-Cookie'], /^refreshToken=[0-9a-f]{64};/);

  const who = await ctx.server.route(
    makeEvent({ path: '/api/admin/session', headers: bearer(body.accessToken) })
  );
  assert.equal(who.statusCode, 200);
  const session = JSON.parse(who.body);
  assert.equal(session.role, 'ADMIN');
  assert.equal(session.email, EMAIL);
  assert.equal(session.username, USERNAME);
  assert.equal(session.name, 'Site Admin');
});

test('login works with the username as well as the email', async () => {
  const ctx = await newAdmin();
  const res = await login(ctx, { identifier: USERNAME });
  assert.equal(res.statusCode, 200);
});

test('the login limit engages from one IP on successful attempts too', async () => {
  const ctx = await newAdmin();
  let limited = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await login(ctx, { ip: '198.51.100.7' });
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited >= 1, 'the login rate limit engages');
});

test('five failed logins lock the account and the audit records it', async () => {
  const ctx = await newAdmin();
  // The fifth failure is the one that trips the lockout and is reported as
  // such; the four before it are plain invalid-credential answers.
  for (let i = 0; i < 4; i += 1) {
    const res = await login(ctx, { password: 'wrong' });
    assert.equal(res.statusCode, 401);
  }
  const locked = await login(ctx, { password: 'wrong' });
  assert.equal(locked.statusCode, 403, 'the fifth failure reports the lockout');

  const evenCorrect = await login(ctx);
  assert.equal(evenCorrect.statusCode, 403, 'even the right password is refused while locked');

  const token = signAccessToken({ sub: 'primary', role: 'ADMIN' }, ENV.EXCHANGE_JWT_SECRET);
  const audit = await ctx.server.route(makeEvent({ path: '/api/admin/audit', headers: bearer(token) }));
  const rows = JSON.parse(audit.body).rows;
  assert.ok(rows.some((row) => row.action === 'auth.locked'), 'the lockout is audited');
  assert.ok(rows.filter((row) => row.action === 'admin.login.failed').length >= 4, 'failures are audited');
});

// --------------------------------------------------------------- sessions

test('admin routes without a token answer 401', async () => {
  const ctx = await newAdmin();
  const res = await ctx.server.route(makeEvent({ path: '/api/admin/stats' }));
  assert.equal(res.statusCode, 401);
});

test('an alg:none token is rejected', async () => {
  const ctx = await newAdmin();
  const loginRes = await login(ctx);
  const token = JSON.parse(loginRes.body).accessToken || '';
  const forged = token ? `${token.split('.').slice(0, 2).join('.')}.` : '';
  const res = await ctx.server.route(
    makeEvent({ path: '/api/admin/session', headers: bearer(forged) })
  );
  assert.equal(res.statusCode, 401);
});

test('a token signed with the wrong secret is rejected', async () => {
  const ctx = await newAdmin();
  const forged = signAccessToken({ sub: 'primary', role: 'ADMIN' }, 'wrong-secret');
  const res = await ctx.server.route(
    makeEvent({ path: '/api/admin/session', headers: bearer(forged) })
  );
  assert.equal(res.statusCode, 401);
});

test('an expired token is rejected', async () => {
  const ctx = await newAdmin();
  const expired = signAccessToken({ sub: 'primary', role: 'ADMIN' }, ENV.EXCHANGE_JWT_SECRET, -60);
  const res = await ctx.server.route(
    makeEvent({ path: '/api/admin/session', headers: bearer(expired) })
  );
  assert.equal(res.statusCode, 401);
});

test('a non-admin role token is refused', async () => {
  const ctx = await newAdmin();
  const wrongRole = signAccessToken({ sub: 'visitor', role: 'USER' }, ENV.EXCHANGE_JWT_SECRET);
  const res = await ctx.server.route(
    makeEvent({ path: '/api/admin/session', headers: bearer(wrongRole) })
  );
  assert.equal(res.statusCode, 403);
});

test('logout revokes the refresh session', async () => {
  const ctx = await newAdmin();
  const loginRes = await login(ctx);
  const cookie = loginRes.headers['Set-Cookie'];
  const accessToken = JSON.parse(loginRes.body).accessToken;

  const logout = await ctx.server.route(
    makeEvent({
      method: 'POST',
      path: '/api/admin/logout',
      headers: { cookie, ...bearer(accessToken) },
    })
  );
  assert.equal(logout.statusCode, 200);

  const refresh = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/refresh', headers: { cookie } })
  );
  assert.equal(refresh.statusCode, 401, 'the revoked session is dead');
});

test('a refresh session is rotated: reuse of the old cookie fails', async () => {
  const ctx = await newAdmin();
  const loginRes = await login(ctx);
  const oldCookie = loginRes.headers['Set-Cookie'];
  const oldJti = oldCookie.match(/refreshToken=([0-9a-f]+)/)[1];

  const refresh = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/refresh', headers: { cookie: oldCookie } })
  );
  assert.equal(refresh.statusCode, 200);
  const newCookie = refresh.headers['Set-Cookie'];
  const newJti = newCookie.match(/refreshToken=([0-9a-f]+)/)[1];
  assert.notEqual(newJti, oldJti, 'the jti changes on every refresh');

  const replay = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/refresh', headers: { cookie: oldCookie } })
  );
  assert.equal(replay.statusCode, 401, 'replaying the old cookie is refused');
});

// ------------------------------------------- exchange module (canonical)

test('the exchange module walks an order to completion over the canonical paths', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  const created = JSON.parse(
    (await ctx.publicServer.route(
      makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() })
    )).body
  );

  const list = await ctx.server.route(makeEvent({ path: '/api/admin/exchange/orders', headers: bearer(token) }));
  const rows = JSON.parse(list.body).orders;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, created.orderId);
  assert.equal(rows[0].isRedacted, false, 'authenticated admin list carries the full order');
  assert.equal(rows[0].senderName, 'Aung Ko', 'the admin list shows the sender');

  const detail = await ctx.server.route(
    makeEvent({ path: `/api/admin/exchange/orders/${created.orderId}`, headers: bearer(token) })
  );
  assert.equal(JSON.parse(detail.body).senderName, 'Aung Ko', 'the admin sees the full order');

  const approve = await ctx.server.route(
    makeEvent({ method: 'POST', path: `/api/admin/exchange/orders/${created.orderId}/approve`, headers: bearer(token) })
  );
  assert.equal(JSON.parse(approve.body).status, 'APPROVED');

  const complete = await ctx.server.route(
    makeEvent({ method: 'POST', path: `/api/admin/exchange/orders/${created.orderId}/complete`, headers: bearer(token) })
  );
  assert.equal(JSON.parse(complete.body).status, 'COMPLETED');
  assert.ok(JSON.parse(complete.body).completedAt);

  const stats = await ctx.server.route(makeEvent({ path: '/api/admin/exchange/stats', headers: bearer(token) }));
  const body = JSON.parse(stats.body);
  assert.equal(body.total, 1);
  assert.equal(body.counts.COMPLETED, 1);
});

test('an invalid transition is refused', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  const created = JSON.parse(
    (await ctx.publicServer.route(
      makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() })
    )).body
  );
  const complete = await ctx.server.route(
    makeEvent({ method: 'POST', path: `/api/admin/exchange/orders/${created.orderId}/complete`, headers: bearer(token) })
  );
  assert.equal(complete.statusCode, 400);
});

test('an order can be deleted from the exchange module', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  const created = JSON.parse(
    (await ctx.publicServer.route(
      makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() })
    )).body
  );
  const del = await ctx.server.route(
    makeEvent({ method: 'POST', path: `/api/admin/exchange/orders/${created.orderId}/delete`, headers: bearer(token) })
  );
  assert.equal(del.statusCode, 200);
  assert.equal(JSON.parse(del.body).deleted, true);

  const list = await ctx.server.route(makeEvent({ path: '/api/admin/exchange/orders', headers: bearer(token) }));
  assert.equal(JSON.parse(list.body).orders.length, 0);
});

test('rates can be read and applied through the exchange module', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  const set = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/exchange/rates', body: { thbToMmk: 131.25 }, headers: bearer(token) })
  );
  assert.equal(set.statusCode, 200);

  const rates = await ctx.server.route(makeEvent({ path: '/api/admin/exchange/rates', headers: bearer(token) }));
  const body = JSON.parse(rates.body);
  assert.equal(body.thbToMmk, 131.25);
  assert.ok(body.history.length >= 1);
  assert.equal(body.history[0].thbToMmk, 131.25, 'the newest entry is first');

  const pub = await ctx.publicServer.route(makeEvent({ path: '/api/exchange/rates' }));
  assert.equal(JSON.parse(pub.body).thbToMmk, 131.25, 'the public storefront sees the change');
});

test('legacy admin aliases still route to the exchange module', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  const created = JSON.parse(
    (await ctx.publicServer.route(
      makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() })
    )).body
  );

  const stats = await ctx.server.route(makeEvent({ path: '/api/admin/stats', headers: bearer(token) }));
  assert.equal(JSON.parse(stats.body).total, 1);

  const orders = await ctx.server.route(makeEvent({ path: '/api/admin/orders', headers: bearer(token) }));
  assert.equal(JSON.parse(orders.body).orders.length, 1);

  const approve = await ctx.server.route(
    makeEvent({ method: 'POST', path: `/api/admin/orders/${created.orderId}/approve`, headers: bearer(token) })
  );
  assert.equal(JSON.parse(approve.body).status, 'APPROVED');

  const rates = await ctx.server.route(makeEvent({ path: '/api/admin/rates', headers: bearer(token) }));
  assert.ok(JSON.parse(rates.body).thbToMmk > 0);
});

// Regression for the live Blobs bug - the admin function asserts the sentinels
// stay invisible in its listings too.
test('legacy index sentinel keys are ignored by the admin prefix listings', async () => {
  const { server, store, publicServer } = await newAdmin();
  const token = JSON.parse((await login({ server })).body).accessToken;
  const created = JSON.parse(
    (await publicServer.route(makeEvent({ method: 'POST', path: '/api/exchange/orders', body: orderBody() }))).body
  );

  await store.set('order:index', [created.orderId]);
  await store.set('rate:history:index', ['rate:history:old']);
  await store.set('rate:history:old', {
    thbToMmk: 1,
    updatedAt: '2020-01-01T00:00:00.000Z',
    source: 'admin',
    actor: 'admin',
  });

  const list = await server.route(makeEvent({ path: '/api/admin/exchange/orders', headers: bearer(token) }));
  const rows = JSON.parse(list.body).orders;
  assert.equal(rows.length, 1, 'the order:index sentinel is not an order');
  assert.equal(rows[0].id, created.orderId);

  const stats = await server.route(makeEvent({ path: '/api/admin/exchange/stats', headers: bearer(token) }));
  const body = JSON.parse(stats.body);
  assert.equal(body.total, 1);
  assert.equal(body.counts.undefined, undefined, 'no phantom status bucket');

  const rates = await server.route(makeEvent({ path: '/api/admin/exchange/rates', headers: bearer(token) }));
  const history = JSON.parse(rates.body).history;
  assert.ok(history.every((entry) => typeof entry.thbToMmk === 'number'), 'history has no raw key rows');
});

// ---------------------------------------------------------------- dashboard

test('the dashboard bundles stats, rate, recent audit and post counts', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  const res = await ctx.server.route(makeEvent({ path: '/api/admin/dashboard', headers: bearer(token) }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.stats.counts, { PENDING: 0, APPROVED: 0, COMPLETED: 0, REJECTED: 0 });
  assert.ok(body.rate.thbToMmk > 0);
  assert.equal(body.rate.open, true);
  assert.ok(Array.isArray(body.recentAudit));
  assert.deepEqual(body.posts, { company: 0, math: 0 });
});

// ------------------------------------------------------------------ posts

test('posts are created, listed, updated and deleted by an admin', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;

  const create = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/posts/company', body: { date: '2026-10-01', text: 'First post' }, headers: bearer(token) })
  );
  assert.equal(create.statusCode, 200);
  const id = JSON.parse(create.body).id;
  assert.match(id, /^\d+:[0-9a-f]+$/);

  const createMath = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/posts/math', body: { date: '2026-09-15', text: 'Math post' }, headers: bearer(token) })
  );
  assert.equal(createMath.statusCode, 200);

  const list = await ctx.server.route(makeEvent({ path: '/api/admin/posts', headers: bearer(token) }));
  const both = JSON.parse(list.body);
  assert.equal(both.company.length, 1);
  assert.equal(both.math.length, 1);
  assert.equal(both.company[0].id, id);
  assert.equal(both.company[0].text, 'First post');

  const update = await ctx.server.route(
    makeEvent({ method: 'PUT', path: `/api/admin/posts/company/${id}`, body: { date: '2026-10-02', text: 'Edited post', url: 'https://skycreation.dev' }, headers: bearer(token) })
  );
  assert.equal(update.statusCode, 200);

  const after = await ctx.server.route(makeEvent({ path: '/api/admin/posts', headers: bearer(token) }));
  assert.equal(JSON.parse(after.body).company[0].text, 'Edited post');
  assert.equal(JSON.parse(after.body).company[0].url, 'https://skycreation.dev');
  assert.equal(JSON.parse(after.body).company[0].date, '2026-10-02');

  const del = await ctx.server.route(
    makeEvent({ method: 'DELETE', path: `/api/admin/posts/company/${id}`, headers: bearer(token) })
  );
  assert.equal(del.statusCode, 200);

  const gone = await ctx.server.route(makeEvent({ path: '/api/admin/posts', headers: bearer(token) }));
  assert.equal(JSON.parse(gone.body).company.length, 0);
});

test('invalid post input, list or id is refused', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;

  const badDate = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/posts/company', body: { date: 'not-a-date', text: 'x' }, headers: bearer(token) })
  );
  assert.equal(badDate.statusCode, 400);

  const noText = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/posts/company', body: { date: '2026-10-01' }, headers: bearer(token) })
  );
  assert.equal(noText.statusCode, 400);

  const badList = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/posts/news', body: { date: '2026-10-01', text: 'x' }, headers: bearer(token) })
  );
  assert.equal(badList.statusCode, 404);

  const missing = await ctx.server.route(
    makeEvent({ method: 'DELETE', path: '/api/admin/posts/company/123:abcdef', headers: bearer(token) })
  );
  assert.equal(missing.statusCode, 404);
});

test('the public posts endpoint needs no auth and reflects admin edits', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;

  // /api/posts lives in the admin function but needs no auth; the storefront
  // function (ctx.publicServer) does not own it.
  const before = await ctx.server.route(makeEvent({ path: '/api/posts' }));
  assert.equal(before.statusCode, 200);
  assert.deepEqual(JSON.parse(before.body), { company: [], math: [] });

  await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/posts/company', body: { date: '2026-10-01', text: 'Live post' }, headers: bearer(token) })
  );

  const after = await ctx.server.route(makeEvent({ path: '/api/posts' }));
  assert.equal(after.statusCode, 200);
  const body = JSON.parse(after.body);
  assert.equal(body.company.length, 1);
  assert.equal(body.company[0].text, 'Live post');
});

// --------------------------------------------------------------- settings

test('settings reads and writes open state and the default seed rate', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;

  const get1 = await ctx.server.route(makeEvent({ path: '/api/admin/settings', headers: bearer(token) }));
  const before = JSON.parse(get1.body);
  assert.equal(before.open, true);
  assert.ok(before.currentRate > 0);
  assert.equal(before.defaultRate, before.currentRate, 'no stored default falls back to the current rate');

  const closed = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/settings', body: { open: false }, headers: bearer(token) })
  );
  assert.equal(JSON.parse(closed.body).open, false);

  const seed = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/settings', body: { defaultRate: 133 }, headers: bearer(token) })
  );
  assert.equal(seed.statusCode, 200);

  const get2 = await ctx.server.route(makeEvent({ path: '/api/admin/settings', headers: bearer(token) }));
  const after = JSON.parse(get2.body);
  assert.equal(after.open, false);
  assert.equal(after.defaultRate, 133);
});

test('invalid settings input is refused', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  const res = await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/settings', body: { defaultRate: -5 }, headers: bearer(token) })
  );
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------- account

test('the account module changes email and password after verification', async () => {
  const ctx = await newAdmin();

  const token = JSON.parse((await login(ctx)).body).accessToken;
  const wrong = await ctx.server.route(
    makeEvent({ method: 'PATCH', path: '/api/admin/account', body: { currentPassword: 'nope', email: 'x@y.com' }, headers: bearer(token) })
  );
  assert.equal(wrong.statusCode, 403, 'the current password must be verified first');

  const patch = await ctx.server.route(
    makeEvent({
      method: 'PATCH',
      path: '/api/admin/account',
      body: { currentPassword: PASS, email: 'newadmin@skycreation.dev', newPassword: 'new-pass-123', name: 'New Name' },
      headers: bearer(token),
    })
  );
  assert.equal(patch.statusCode, 200);

  const oldPw = await login(ctx, { password: PASS });
  assert.equal(oldPw.statusCode, 401, 'the old password stops working');

  const newPw = await login(ctx, { identifier: 'newadmin@skycreation.dev', password: 'new-pass-123' });
  assert.equal(newPw.statusCode, 200);

  const session = await ctx.server.route(
    makeEvent({ path: '/api/admin/session', headers: bearer(JSON.parse(newPw.body).accessToken) })
  );
  const who = JSON.parse(session.body);
  assert.equal(who.email, 'newadmin@skycreation.dev');
  assert.equal(who.name, 'New Name');
});

// ------------------------------------------------------------------ audit

test('the unified audit log records admin actions', async () => {
  const ctx = await newAdmin();
  const token = JSON.parse((await login(ctx)).body).accessToken;
  await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/exchange/rates', body: { thbToMmk: 130 }, headers: bearer(token) })
  );
  await ctx.server.route(
    makeEvent({ method: 'POST', path: '/api/admin/posts/company', body: { date: '2026-10-01', text: 'x' }, headers: bearer(token) })
  );

  const audit = await ctx.server.route(makeEvent({ path: '/api/admin/audit', headers: bearer(token) }));
  assert.equal(audit.statusCode, 200);
  const rows = JSON.parse(audit.body).rows;
  const actions = rows.map((row) => row.action);
  assert.ok(actions.includes('admin.login'), 'the login is audited');
  assert.ok(actions.includes('rate.updated'), 'the rate change is audited');
  assert.ok(actions.includes('post.created'), 'the post create is audited');
  assert.ok(rows.every((row) => row.actor), 'every entry has an actor');
});