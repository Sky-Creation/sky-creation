/* Behavioural tests for the exchange client scripts (assets/exchange.js and
 * assets/admin.js), following the same live-DOM style as main.test.mjs: the
 * scripts are plain IIFEs, so they are evaluated against a minimal fake DOM in
 * a VM and the listeners are captured and invoked directly.
 *
 * The rules enforced here mirror the server tests:
 *   - an order is only shown as created after the server answers with a real
 *     order id - a success message shown before the send is a bug;
 *   - the honeypot value is forwarded for the server to filter on;
 *   - the admin token is stored only after a successful login and cleared on
 *     401, and the dashboard is only shown after login reports success.
 *
 * Run: node --test test/*.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const exchangeSource = readFileSync(join(here, '..', 'site', 'assets', 'exchange.js'), 'utf8');
const adminSource = readFileSync(join(here, '..', 'site', 'assets', 'admin.js'), 'utf8');

/* ------------------------------------------------------- fake DOM helpers */

function makeEl(tag = 'div') {
  const el = {
    tag,
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    checked: false,
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; },
    removeAttribute(key) { delete this.attrs[key]; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      return child;
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    focus() {},
  };
  return el;
}

function makeStorage() {
  const data = {};
  return {
    getItem(key) { return key in data ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
    _data: data,
  };
}

const settle = () => new Promise((r) => setImmediate(r));

/** Collect every textContent assigned anywhere in a fake element tree. */
function subtreeText(root) {
  const texts = [];
  (function walk(node) {
    if (node && node.textContent) texts.push(node.textContent);
    (node.children || []).forEach(walk);
    for (const key of Object.keys(node || {})) {
      const child = node[key];
      if (child && Array.isArray(child)) child.forEach(walk);
    }
  })(root);
  return texts.join(' | ');
}

/** Build a fake <form> that records its submit listener and answers the
 * querySelector calls the scripts make (status paragraph, submit button). */
function makeForm(fields, statusEl) {
  const form = makeEl('form');
  const submitBtn = Object.assign(makeEl('button'), { disabled: false });
  const listeners = {};
  const raw = {
    elements: fields,
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector(sel) {
      if (sel === '.form-status') return statusEl;
      if (sel === 'button[type="submit"]') return submitBtn;
      return null;
    },
  };
  return { raw, listeners, submitBtn };
}

/** A panel that exposes querySelector for the [data-*] text sinks. */
function makePanel(childrenBySelector) {
  const panel = makeEl('div');
  panel.hidden = true;
  panel.querySelector = (sel) => childrenBySelector[sel] || null;
  Object.assign(childrenBySelector, {});
  return panel;
}

/* ------------------------------------------------------------ exchange.js */

function loadExchange({ search = '', guests = [], respondRoutes = {} } = {}) {
  const calls = { fetch: [] };
  const statusEl = makeEl('p');

  const formFields = {
    amount: Object.assign(makeEl('input'), { value: '5000' }),
    direction: Object.assign(makeEl('select'), { value: 'THB_TO_MMK' }),
    method: Object.assign(makeEl('select'), { value: 'KBZPay' }),
    level: Object.assign(makeEl('select'), { value: 'Standard' }),
    senderName: Object.assign(makeEl('input'), { value: ' Aung Ko ' }),
    senderContact: Object.assign(makeEl('input'), { value: ' +95012345678 ' }),
    accountNo: makeEl('input'),
    accountName: makeEl('input'),
    note: makeEl('input'),
    company: Object.assign(makeEl('input'), { value: '' }),
  };
  const { raw: orderForm, listeners } = makeForm(formFields, statusEl);

  const createdRef = makeEl('span');
  const createdAmount = makeEl('span');
  const createdReceive = makeEl('span');
  const createdRate = makeEl('span');
  const createdTrack = makeEl('a');
  const createdCopy = makeEl('button');
  const createdPanel = makePanel({
    '[data-ref]': createdRef,
    '[data-amount]': createdAmount,
    '[data-receive]': createdReceive,
    '[data-rate]': createdRate,
    '[data-track]': createdTrack,
    '[data-copy-link]': createdCopy,
  });

  const guestList = makeEl('div');
  const orderDetail = makePanel({
    '[data-ref]': makeEl('span'),
    '[data-amount]': makeEl('span'),
  });

  const bySel = {
    '#exchange-app': makeEl('section'),
    '#calc-send-amount': Object.assign(makeEl('input'), { value: '5000' }),
    '#calc-send-code': makeEl('span'),
    '#calc-receive-code': makeEl('span'),
    '#calc-send-badge': makeEl('span'),
    '#calc-receive-badge': makeEl('span'),
    '#order-form': orderForm,
    '#order-created': createdPanel,
    '#orders-page': makeEl('section'),
    '#guest-orders-list': guestList,
    '#order-detail': orderDetail,
  };

  const storage = makeStorage();
  if (guests.length) storage.setItem('sky_exchange_guest_orders', JSON.stringify(guests));

  const fetchImpl = (url, opts) => {
    calls.fetch.push({ url, method: (opts && opts.method) || 'GET', body: JSON.parse((opts && opts.body) || '{}') });
    const route = respondRoutes[url] || { status: 200, body: {} };
    return Promise.resolve({
      ok: route.status < 400,
      status: route.status,
      json: () => Promise.resolve(route.body),
    });
  };

  const context = {
    window: { location: { search }, localStorage: storage, SKY_EXCHANGE: null },
    document: {
      readyState: 'complete',
      querySelector: (sel) => bySel[sel] || null,
      querySelectorAll: () => [],
      createElement: (tag) => makeEl(tag),
      createTextNode: (text) => makeEl('#text'),
      addEventListener() {},
    },
    fetch: fetchImpl,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(exchangeSource, context);

  return {
    submit: listeners.submit,
    calls,
    form: orderForm,
    statusEl,
    createdPanel,
    createdRef,
    guestList,
    orderDetail,
    storage,
    SKY: context.window.SKY_EXCHANGE,
    settle,
  };
}

const RATES_RESPONSE = { status: 200, body: { open: true, thbToMmk: 128.5, mmkToThb: 0.0078, minimums: { THB: 100, MMK: 10000 }, levels: [{ id: 'Standard', name: 'Standard' }], channels: [{ id: 'KBZPay', name: 'KBZPay' }] } };

test('exchange.js reports success only after the server answers with an order id', async () => {
  const { submit, calls, form, createdPanel, createdRef, settle, SKY } = loadExchange({
    respondRoutes: {
      '/api/exchange/rates': RATES_RESPONSE,
      '/api/exchange/orders': {
        status: 200,
        body: { ok: true, orderId: 'order-1', reference: 'SC-1', status: 'PENDING', direction: 'THB_TO_MMK', amount: 5000, receiveAmount: 642500, rateUsed: 128.5, viewToken: 'ab'.repeat(24) },
      },
    },
  });

  assert.equal(createdPanel.hidden, true, 'nothing is shown as created before the send');
  submit({ preventDefault() {} });
  await settle();

  const sent = calls.fetch.filter((c) => c.url === '/api/exchange/orders');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.senderName, 'Aung Ko', 'fields are trimmed');
  assert.equal(sent[0].body.amount, 5000);
  assert.equal(sent[0].body.direction, 'THB_TO_MMK');
  assert.ok('company' in sent[0].body, 'the honeypot value is forwarded');

  assert.equal(createdPanel.hidden, false, 'success is shown only after the order id arrives');
  assert.equal(createdRef.textContent, 'SC-1');
  assert.equal(SKY.getGuestOrders().length, 1, 'the order is remembered on this device');
  assert.equal(SKY.getGuestOrders()[0].viewToken, 'ab'.repeat(24));
});

test('exchange.js refuses an order below the minimum without fetching', async () => {
  const { submit, calls, statusEl, form, settle } = loadExchange({});
  form.elements.amount.value = '50';
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.filter((c) => c.url === '/api/exchange/orders').length, 0);
  assert.equal(statusEl.attrs['data-state'], 'error');
});

test('exchange.js disables the honeypot control at load', async () => {
  const { form } = loadExchange({});
  assert.equal(form.elements.company.disabled, true, 'the trap is locked to humans');
});

test('exchange.js renders the guest order list from the resolver', async () => {
  const { guestList, settle } = loadExchange({
    guests: [{ id: 'order-1', viewToken: 'ab'.repeat(24), createdAt: Date.now() }],
    respondRoutes: {
      '/api/exchange/rates': RATES_RESPONSE,
      '/api/exchange/orders/list': {
        status: 200,
        body: { orders: [{ id: 'order-1', reference: 'SC-1', status: 'PENDING', isRedacted: true, amount: 5000, receiveAmount: 642500, createdAt: '2026-10-10T00:00:00.000Z' }] },
      },
    },
  });
  await settle();

  assert.ok(guestList.children.length >= 1, 'a card was rendered for the remembered order');
  assert.ok(subtreeText(guestList).includes('SC-1'), 'the reference appears on the card');
});

test('exchange.js shows a detail panel for a tracked order', async () => {
  const { orderDetail, settle } = loadExchange({
    search: `?id=order-1&token=${'ab'.repeat(24)}`,
    respondRoutes: {
      '/api/exchange/rates': RATES_RESPONSE,
      '/api/exchange/orders/list': {
        status: 200,
        body: { orders: [{ id: 'order-1', reference: 'SC-1', status: 'PENDING', isRedacted: false, senderName: 'Aung Ko', senderContact: '+95012345678', amount: 5000, receiveAmount: 642500, rateUsed: 128.5, createdAt: '2026-10-10T00:00:00.000Z', hasProof: false }] },
      },
    },
  });
  await settle();

  assert.ok(orderDetail.children.length > 0, 'the panel is populated for a known order');
  assert.ok(subtreeText(orderDetail).includes('SC-1'));
});

/* ---------------------------------------------------------------- admin.js */

const ADMIN_OK = (body, extra = {}) => ({ status: 200, body, ...extra });

function loadAdmin({ routes = {} } = {}) {
  const calls = { fetch: [] };
  const loginStatus = makeEl('p');
  const loginEl = makeEl('div');
  loginEl.hidden = true;
  const appEl = makeEl('div');
  appEl.hidden = true;

  const formFields = { password: Object.assign(makeEl('input'), { value: 'correct' }) };
  const { raw: loginForm, listeners } = makeForm(formFields, loginStatus);

  const panels = ['stats', 'orders', 'rates', 'audit'].reduce((acc, id) => {
    acc[id] = makeEl('div');
    return acc;
  }, {});

  const bySel = {
    '#admin-login': loginEl,
    '#admin-app': appEl,
    '#admin-login-form': loginForm,
    '#admin-login-status': loginStatus,
    '#admin-panel-stats': panels.stats,
    '#admin-panel-orders': panels.orders,
    '#admin-panel-rates': panels.rates,
    '#admin-panel-audit': panels.audit,
  };

  const storage = makeStorage();

  const fetchImpl = (url, opts) => {
    calls.fetch.push({
      url,
      method: (opts && opts.method) || 'GET',
      body: opts && opts.body ? JSON.parse(opts.body) : {},
      auth: (opts && opts.headers && opts.headers.Authorization) || null,
    });
    const route = routes[url.split('?')[0]] || { status: 401, body: { error: 'no route' } };
    return Promise.resolve({ ok: route.status < 400, status: route.status, json: () => Promise.resolve(route.body) });
  };

  const context = {
    window: { localStorage: storage },
    document: {
      readyState: 'complete',
      querySelector: (sel) => bySel[sel] || null,
      querySelectorAll: () => [],
      createElement: (tag) => makeEl(tag),
      createTextNode: (text) => makeEl('#text'),
      addEventListener() {},
    },
    fetch: fetchImpl,
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(adminSource, context);

  return {
    submit: listeners.submit,
    calls,
    loginEl,
    appEl,
    loginStatus,
    storage,
    settle,
  };
}

test('admin.js stores the token and shows the dashboard only after login success', async () => {
  const { submit, calls, appEl, loginEl, storage, settle } = loadAdmin({
    routes: {
      '/api/admin/login': ADMIN_OK({ ok: true, accessToken: 'access-token', role: 'ADMIN', expiresInSeconds: 900 }),
      '/api/admin/session': ADMIN_OK({ ok: true }),
      '/api/admin/stats': ADMIN_OK({ total: 1, counts: { PENDING: 1, APPROVED: 0, COMPLETED: 0, REJECTED: 0 }, pendingVolume: 642500 }),
      '/api/admin/orders': ADMIN_OK({ orders: [] }),
      '/api/admin/rates': ADMIN_OK({ thbToMmk: 128.5, open: true, history: [] }),
      '/api/admin/audit': ADMIN_OK({ rows: [], page: 1, perPage: 25, totalKeys: 0 }),
    },
  });

  submit({ preventDefault() {} });
  await settle();

  const loginCall = calls.fetch.find((c) => c.url === '/api/admin/login');
  assert.ok(loginCall, 'a login attempt is made');
  assert.equal(loginCall.method, 'POST');
  assert.equal(loginCall.body.password, 'correct');

  assert.equal(storage.getItem('sky_admin_token'), 'access-token', 'the token is stored');
  assert.equal(appEl.hidden, false, 'the dashboard is shown');
  assert.equal(loginEl.hidden, true, 'the login view is hidden');

  const authed = calls.fetch.filter((c) => c.url !== '/api/admin/login');
  assert.ok(authed.length >= 4, 'stats, orders, rates and audit are all fetched');
  assert.ok(authed.every((c) => c.auth === 'Bearer access-token'), 'every dashboard call carries the token');
});

test('admin.js clears the token and returns to login on a 401', async () => {
  const { submit, loginEl, loginStatus, storage, settle } = loadAdmin({
    routes: { '/api/admin/login': { status: 401, body: { error: 'Incorrect passcode' } } },
  });

  submit({ preventDefault() {} });
  await settle();

  assert.equal(storage.getItem('sky_admin_token'), null, 'the bad token is dropped');
  assert.equal(loginEl.hidden, false, 'the login screen is shown again');
  assert.equal(loginStatus.attrs['data-state'], 'error');
});