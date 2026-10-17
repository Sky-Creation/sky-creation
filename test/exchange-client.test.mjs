/* Behavioural tests for the exchange client script (assets/exchange.js),
 * following the same live-DOM style as main.test.mjs: the script is a plain
 * IIFE, so it is evaluated against a minimal fake DOM in a VM and the
 * listeners are captured and invoked directly.
 *
 * The rules enforced here mirror the server tests:
 *   - an order is only shown as created after the server answers with a real
 *     order id - a success message shown before the send is a bug;
 *   - the honeypot value is forwarded for the server to filter on.
 *
 * The admin panel has its own suite (admin-client.test.mjs) and its own
 * script; nothing here touches assets/admin.js.
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

function loadExchange({ search = '', hash = '', guests = [], respondRoutes = {} } = {}) {
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
    '#calc-receive-amount': Object.assign(makeEl('input'), { value: '' }),
    '#calc-rate-input': Object.assign(makeEl('input'), { value: '' }),
    '#calc-rate-display': makeEl('span'),
    '#calc-min-hint': makeEl('span'),
    '#calc-reset-rate': Object.assign(makeEl('button'), {}),
    '#calc-swap-btn': Object.assign(makeEl('button'), {}),
    '#order-min-hint': makeEl('span'),
    '#order-direction': Object.assign(makeEl('input'), { value: '' }),
    '#order-form': orderForm,
    '#order-created': createdPanel,
    '#orders-page': makeEl('section'),
    '#guest-orders-list': guestList,
    '#order-detail': orderDetail,
  };

  const storage = makeStorage();
  if (guests.length) storage.setItem('sky_exchange_guest_orders', JSON.stringify(guests));

  const location = {
    search,
    hash,
    pathname: '/orders',
  };

  const fetchImpl = (url, opts) => {
    calls.fetch.push({
      url,
      method: (opts && opts.method) || 'GET',
      body: opts && opts.body ? JSON.parse(opts.body) : undefined,
      headers: (opts && opts.headers) || {},
    });
    const route = respondRoutes[url] || { status: 200, body: {} };
    return Promise.resolve({
      ok: route.status < 400,
      status: route.status,
      json: () => Promise.resolve(route.body),
    });
  };

  const context = {
    window: {
      location,
      history: {
        replaceState(_a, _b, url) {
          const parsed = new URL(url, 'https://skycreation.dev');
          location.search = parsed.search;
          location.hash = parsed.hash;
          location.pathname = parsed.pathname;
        },
      },
      localStorage: storage,
      SKY_EXCHANGE: null,
    },
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
    URL,
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
    converter: {
      send: bySel['#calc-send-amount'],
      receive: bySel['#calc-receive-amount'],
      rateInput: bySel['#calc-rate-input'],
      display: bySel['#calc-rate-display'],
      resetButton: bySel['#calc-reset-rate'],
    },
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
  await settle();

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
  const { submit, calls, statusEl, form, settle } = loadExchange({
    respondRoutes: { '/api/exchange/rates': RATES_RESPONSE },
  });
  await settle();
  form.elements.amount.value = '50';
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.filter((c) => c.url === '/api/exchange/orders').length, 0);
  assert.equal(statusEl.attrs['data-state'], 'error');
});

test('exchange.js refuses orders while the exchange is closed', async () => {
  const { submit, calls, statusEl, settle } = loadExchange({
    respondRoutes: {
      '/api/exchange/rates': {
        status: 200,
        body: { ...RATES_RESPONSE.body, open: false },
      },
    },
  });
  await settle();
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.filter((c) => c.url === '/api/exchange/orders').length, 0);
  assert.match(statusEl.textContent, /closed/i);
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
        body: { orders: [{ id: 'order-1', reference: 'SC-1', status: 'PENDING', isRedacted: true, createdAt: '2026-10-10T00:00:00.000Z' }] },
      },
    },
  });
  await settle();

  assert.ok(guestList.children.length >= 1, 'a card was rendered for the remembered order');
  assert.ok(subtreeText(guestList).includes('SC-1'), 'the reference appears on the card');
  assert.ok(subtreeText(guestList).includes('Private details'), 'redacted cards hide amounts');
});

test('exchange.js shows a detail panel for a tracked order', async () => {
  const token = 'ab'.repeat(24);
  const { orderDetail, calls, settle } = loadExchange({
    search: '?id=order-1',
    hash: `#token=${token}`,
    respondRoutes: {
      '/api/exchange/rates': RATES_RESPONSE,
      '/api/exchange/orders/order-1': {
        status: 200,
        body: { id: 'order-1', reference: 'SC-1', status: 'PENDING', isRedacted: false, senderName: 'Aung Ko', senderContact: '+95012345678', amount: 5000, receiveAmount: 642500, rateUsed: 128.5, direction: 'THB_TO_MMK', createdAt: '2026-10-10T00:00:00.000Z', hasProof: false },
      },
    },
  });
  await settle();

  const detail = calls.fetch.find((c) => c.url === '/api/exchange/orders/order-1');
  assert.ok(detail, 'detail is fetched by id');
  assert.equal(detail.headers['X-View-Token'], token);
  assert.ok(orderDetail.children.length > 0, 'the panel is populated for a known order');
  assert.ok(subtreeText(orderDetail).includes('SC-1'));
});

test('exchange.js detail panel labels a MMK->THB order in its own units', async () => {
  // rateUsed is stored per-direction (THB per MMK here), so the label must not
  // hard-code "1 THB = X MMK": that misread MMK buys as THB sends.
  const token = 'cd'.repeat(24);
  const { orderDetail, settle } = loadExchange({
    search: '?id=mmk-order',
    hash: `#token=${token}`,
    respondRoutes: {
      '/api/exchange/rates': RATES_RESPONSE,
      '/api/exchange/orders/mmk-order': {
        status: 200,
        body: { id: 'mmk-order', reference: 'SC-9', status: 'PENDING', direction: 'MMK_TO_THB', isRedacted: false, amount: 10000, receiveAmount: 77.82, rateUsed: 0.0078, createdAt: '2026-10-10T00:00:00.000Z', hasProof: false },
      },
    },
  });
  await settle();

  const text = subtreeText(orderDetail);
  assert.ok(text.includes('10,000 MMK'), 'send side shows the right unit: ' + text);
  assert.ok(text.includes('77.82 THB'), 'receive side shows THB: ' + text);
  assert.ok(text.includes('1 MMK = 0.0078 THB'), 'rate is framed in MMK-native terms: ' + text);
});

test('exchange.js MMK->THB reset restores the live rate, not its reciprocal', async () => {
  // rateForDirection() once returned 1/thbToMmk for MMK_TO_THB, so Reset and
  // the empty-field fallback wrote 0.01 into a rate that calculate() then
  // divided by - inflating the result ~rate^2 (12794 x in the fixture).
  const { converter, SKY, settle } = loadExchange({
    respondRoutes: { '/api/exchange/rates': RATES_RESPONSE },
  });
  await settle();

  SKY.state.direction = 'MMK_TO_THB';
  converter.send.value = '10000';
  converter.receive.value = '';
  converter.rateInput.value = '';
  converter.resetButton.listeners.click();

  assert.equal(converter.rateInput.value, '128.50', 'Reset writes the live MMK-per-THB rate');
  assert.equal(converter.receive.value, '77.82', '10000 MMK / 128.5 = 77.82 THB, not ~1.28M');
  assert.ok(converter.display.textContent.includes('1 THB = 128.5 MMK'), 'display stays in THB terms');

  // The empty-field fallback takes the same path as Reset.
  converter.rateInput.value = '';
  converter.send.listeners.input();
  assert.equal(converter.receive.value, '77.82', 'empty rate input falls back to the live rate');
});

test('exchange.js THB->MMK reset still multiplies by the live rate', async () => {
  const { converter, settle } = loadExchange({
    respondRoutes: { '/api/exchange/rates': RATES_RESPONSE },
  });
  await settle();

  converter.rateInput.value = '';
  converter.resetButton.listeners.click();
  assert.equal(converter.rateInput.value, '128.50');
  assert.equal(converter.receive.value, '642,500', '5000 THB x 128.5 = 642500 MMK');
});

test('exchange.js keeps a stale guest order visible without a token', async () => {
  // The server resolved an order whose id is not in this device's localStorage
  // (stale link, wiped storage). Once the guest lookup returned undefined and
  // guest.viewToken threw, the whole list collapsed into the empty state.
  const { guestList, settle } = loadExchange({
    guests: [{ id: 'remembered-1', viewToken: 'ab'.repeat(24) }],
    respondRoutes: {
      '/api/exchange/rates': RATES_RESPONSE,
      '/api/exchange/orders/list': {
        status: 200,
        body: { orders: [{ id: 'other-1', reference: 'SC-2', status: 'PENDING', isRedacted: true, createdAt: '2026-10-10T00:00:00.000Z' }] },
      },
    },
  });
  await settle();

  assert.equal(guestList.children.length, 1, 'the returned order still renders');
  const view = guestList.children[0].children.find((c) => c.className === 'btn btn-ghost');
  assert.ok(view, 'card carries a view link');
  assert.ok(view.href.includes('/orders?id=other-1'), 'link points at the order');
  assert.ok(!view.href.includes('token='), 'no remembered token, so no token is appended');
});