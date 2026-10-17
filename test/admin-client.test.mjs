/* Behavioural tests for the admin panel client (site/assets/admin.js).
 *
 * The script is a plain IIFE with no export, so it is evaluated against a
 * hand-built DOM (login view, admin view, six panels, tab buttons) inside a
 * Node vm with a scriptable fetch. The access token lives in memory; boot
 * asks POST /api/admin/refresh (httpOnly cookie) for a fresh token.
 *
 * The invariants that matter client-side:
 *   - a login only "succeeds" after the server answers (no timing gate);
 *   - the access token is held in memory, sent as a Bearer header, and a 401
 *     anywhere drops it and returns to the login screen;
 *   - destructive actions (order delete) go through a confirm panel before any
 *     request is made.
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
const source = readFileSync(join(here, '..', 'site', 'assets', 'admin.js'), 'utf8');

const MODULES = ['dashboard', 'exchange', 'posts', 'settings', 'audit', 'account'];

function makeEl(tag) {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  let text = '';
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    className: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    type: '',
    name: '',
    step: '',
    min: '',
    maxLength: 0,
    rows: 0,
    href: '',
    rel: '',
    id: '',
    attrs,
    classes,
    children: [],
    parentNode: null,
    listeners,
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    replaceChild(oldChild, newChild) {
      const i = this.children.indexOf(oldChild);
      if (i !== -1) this.children.splice(i, 1, newChild);
      newChild.parentNode = this;
    },
    replaceWith(newNode) {
      if (this.parentNode) this.parentNode.replaceChild(this, newNode);
    },
    setAttribute(key, value) { attrs[key] = String(value); },
    removeAttribute(key) { delete attrs[key]; },
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
  };
  // Mirror the browser: assigning textContent replaces all children.
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    set(value) {
      text = value == null ? '' : String(value);
      node.children.length = 0;
    },
    configurable: true,
  });
  return node;
}

function makeFormElements(fields) {
  const elements = {};
  Object.keys(fields).forEach((name) => {
    const input = makeEl('input');
    input.name = name;
    input.value = fields[name] ?? '';
    elements[name] = input;
  });
  return elements;
}

function respond(body, status = 200) {
  return {
    ok: status < 400,
    status,
    body,
    json: () => Promise.resolve(body),
  };
}

/** Routes: map of exact url -> (options) => body | {status, body} | {blobBody}. */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options: options || {} });
    const route = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : null;
    if (!route) return Promise.resolve(respond({ error: 'unexpected route ' + url }, 404));
    const out = route(options || {}, url);
    if (out && out.blobBody) {
      return Promise.resolve({
        ok: (out.status || 200) < 400,
        status: out.status || 200,
        json: () => Promise.resolve(out.body || {}),
        blob: () => Promise.resolve(out.blobBody),
      });
    }
    return Promise.resolve(
      typeof out.status === 'number' ? respond(out.body, out.status) : respond(out)
    );
  };
  return { calls, fetchImpl };
}

const DASHBOARD_BODY = {
  stats: {
    total: 5,
    counts: { PENDING: 2, APPROVED: 1, COMPLETED: 1, REJECTED: 1 },
    volume: 50000,
    pendingVolume: 12850,
    series: [
      { day: '2026-10-16', count: 2, volumeMmk: 20000, byStatus: { PENDING: 1, APPROVED: 0, COMPLETED: 1, REJECTED: 0 } },
      { day: '2026-10-17', count: 3, volumeMmk: 30000, byStatus: { PENDING: 1, APPROVED: 1, COMPLETED: 0, REJECTED: 1 } },
    ],
    filters: { from: null, to: null, status: null },
  },
  rate: { thbToMmk: 128.5, open: true },
  posts: { company: 1, math: 0 },
  recentAudit: [],
  recentRateHistory: [{ updatedAt: '2026-10-16T12:00:00.000Z', thbToMmk: 128.5, actor: 'admin' }],
  filters: { from: null, to: null, status: null },
};

const ORDER = {
  id: 'o1',
  reference: 'SCI-000001',
  status: 'PENDING',
  amount: 100,
  direction: 'THB_TO_MMK',
  receiveAmount: 12850,
  rateUsed: 128.5,
  senderName: 'Ada',
  method: 'KBZPay',
  level: 'normal',
};

const ORDER_DETAIL = {
  ...ORDER,
  senderContact: '+66999999999',
  accountNo: '1234567',
  accountName: 'Ada Lovelace',
  note: 'Family',
  fee: 0,
  hasProof: true,
  proofFileName: 'receipt.jpg',
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  viewToken: 'a'.repeat(48),
};

function build() {
  const docListeners = {};
  const doc = {
    readyState: 'complete',
    body: makeEl('body'),
    listeners: docListeners,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = docListeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
  };
  doc.createElement = (tag) => makeEl(tag);
  doc.createTextNode = (text) => ({ nodeType: 3, textContent: text });

  const loginView = doc.createElement('div');
  const adminView = doc.createElement('div');
  adminView.hidden = true;

  const loginForm = doc.createElement('form');
  loginForm.elements = makeFormElements({ identifier: '', password: '' });
  const loginSubmit = doc.createElement('button');
  loginSubmit.type = 'submit';
  loginSubmit.textContent = 'Sign in';
  loginForm.children.push(loginSubmit);
  loginForm.querySelector = (sel) => (sel === 'button[type="submit"]' ? loginSubmit : null);

  const loginStatus = doc.createElement('p');
  const logoutBtn = doc.createElement('button');

  const tabs = MODULES.map((name) => {
    const btn = doc.createElement('button');
    btn.setAttribute('data-admin-tab', name);
    return btn;
  });

  const panels = {};
  MODULES.forEach((name) => { panels[name] = doc.createElement('div'); });

  const selectorMap = {
    '#admin-login': loginView,
    '#admin-app': adminView,
    '#admin-login-form': loginForm,
    '#admin-login-status': loginStatus,
    '#admin-logout-btn': logoutBtn,
  };
  Object.keys(panels).forEach((name) => { selectorMap['#admin-panel-' + name] = panels[name]; });

  doc.querySelector = (sel) => (Object.prototype.hasOwnProperty.call(selectorMap, sel) ? selectorMap[sel] : null);
  doc.querySelectorAll = (sel) => (sel === '[data-admin-tab]' ? tabs.slice() : []);
  doc.getElementById = (id) => (selectorMap['#' + id] || null);

  return { doc, loginView, adminView, loginForm, loginSubmit, loginStatus, logoutBtn, tabs, panels };
}

function loadAdmin({ bootToken = null, routes = {} } = {}) {
  const { doc, loginView, adminView, loginForm, loginSubmit, loginStatus, logoutBtn, tabs, panels } = build();
  const merged = {
    '/api/admin/refresh': () => (
      bootToken
        ? respond({ ok: true, accessToken: bootToken, role: 'ADMIN', expiresInSeconds: 900 })
        : { status: 401, body: { error: 'No refresh session' } }
    ),
    ...routes,
  };
  const make = makeFetch(merged);
  const copied = [];
  const objectUrls = [];

  const context = {
    window: {},
    document: doc,
    fetch: make.fetchImpl,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    navigator: {
      clipboard: {
        writeText(text) {
          copied.push(text);
          return Promise.resolve();
        },
      },
    },
    URL: {
      createObjectURL(blob) {
        const url = 'blob:mock-' + objectUrls.length;
        objectUrls.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) {
        const i = objectUrls.findIndex((entry) => entry.url === url);
        if (i !== -1) objectUrls.splice(i, 1);
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const settle = () => new Promise((r) => setImmediate(r));

  function click(el, listeners, event) {
    const list = el.listeners[listeners || 'click'] || [];
    if (!list.length) throw new Error('no ' + listeners + ' listener on node');
    const evt = event || { preventDefault() {} };
    list.slice().forEach((fn) => fn(evt));
  }

  function all(root, pred) {
    const out = [];
    (function walk(node) {
      (node.children || []).forEach((child) => {
        if (pred(child)) out.push(child);
        walk(child);
      });
    })(root);
    return out;
  }

  return {
    calls: make.calls,
    settle,
    click,
    all,
    doc,
    loginView,
    adminView,
    loginForm,
    loginSubmit,
    loginStatus,
    logoutBtn,
    tabs,
    panels,
    copied,
    objectUrls,
  };
}

test('with no refresh session the login screen is shown', async () => {
  const app = loadAdmin();
  await app.settle();
  assert.equal(app.loginView.hidden, false, 'login view is visible');
  assert.equal(app.adminView.hidden, true, 'admin view stays hidden');
  assert.ok(app.calls.some((c) => c.url === '/api/admin/refresh'), 'boot probes refresh');
});

test('a failed login shows the server error and keeps the session absent', async () => {
  const app = loadAdmin({
    routes: {
      '/api/admin/login': () => ({ status: 401, body: { error: 'Check your password.' } }),
    },
  });
  await app.settle();

  app.loginForm.elements.identifier.value = 'admin';
  app.loginForm.elements.password.value = 'wrong';
  app.click(app.loginForm, 'submit');
  await app.settle();

  assert.match(app.loginStatus.textContent, /password/i);
  assert.equal(app.loginView.hidden, false, 'still on the login screen');
});

test('a successful login opens the dashboard and sends the token as Bearer', async () => {
  const app = loadAdmin({
    routes: {
      '/api/admin/login': () => respond({ accessToken: 'tok-123', role: 'ADMIN' }),
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
    },
  });
  await app.settle();

  app.loginForm.elements.identifier.value = 'admin';
  app.loginForm.elements.password.value = 'hunter2';
  app.click(app.loginForm, 'submit');
  await app.settle();
  await app.settle();

  assert.equal(app.loginView.hidden, true);
  assert.equal(app.adminView.hidden, false);

  const dash = app.calls.find((c) => c.url === '/api/admin/dashboard');
  assert.ok(dash, 'the dashboard is loaded on entry');
  assert.equal(dash.options.headers.Authorization, 'Bearer tok-123');
  assert.ok(
    app.all(app.panels.dashboard, (n) => n.className === 'admin-stat-number').length >= 6,
    'six stat cards render'
  );
});

test('a valid refresh cookie boots straight into the dashboard', async () => {
  const app = loadAdmin({
    bootToken: 'tok-keep',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
    },
  });
  await app.settle();
  await app.settle();

  assert.equal(app.adminView.hidden, false);
  assert.equal(
    app.calls.find((c) => c.url === '/api/admin/dashboard').options.headers.Authorization,
    'Bearer tok-keep'
  );
});

test('a failed refresh falls back to login', async () => {
  const app = loadAdmin();
  await app.settle();

  assert.equal(app.loginView.hidden, false);
  assert.equal(app.adminView.hidden, true);
});

test('a 401 during normal use returns to login', async () => {
  const app = loadAdmin({
    bootToken: 'tok-live',
    routes: {
      '/api/admin/dashboard': () => ({ status: 401, body: { error: 'Session expired' } }),
    },
  });
  await app.settle();
  await app.settle();

  assert.equal(app.loginView.hidden, false);
  assert.equal(app.adminView.hidden, true);
  assert.match(app.loginStatus.textContent, /expired/i);
});

test('logout clears the session and shows the login view', async () => {
  const app = loadAdmin({
    bootToken: 'tok-live',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/logout': () => respond({}),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.logoutBtn);
  await app.settle();

  assert.equal(app.loginView.hidden, false);
  assert.equal(app.adminView.hidden, true);
});

test('the exchange module lists orders from the API', async () => {
  const app = loadAdmin({
    bootToken: 'tok-1',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=25&page=1': () => respond({ orders: [ORDER], total: 1, page: 1, perPage: 25 }),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.tabs[1]); // exchange
  await app.settle();

  const req = app.calls.find((c) => c.url.startsWith('/api/admin/exchange/orders'));
  assert.equal(req.url, '/api/admin/exchange/orders?perPage=25&page=1');
  assert.equal(req.options.headers.Authorization, 'Bearer tok-1');
  assert.ok(
    app.all(app.panels.exchange, (n) => String(n.className).includes('ex-order-card') && n.tagName === 'ARTICLE').length === 1,
    'the order card renders'
  );
  assert.ok(
    app.all(app.panels.exchange, (n) => n.tagName === 'BUTTON' && n.textContent === 'Delete').length === 1,
    'a delete action is offered'
  );
  assert.ok(
    app.all(app.panels.exchange, (n) => n.tagName === 'P' && n.textContent.includes('Ada')).length === 1,
    'the admin card shows the sender name'
  );
});

test('deleting an order asks for confirmation before any request', async () => {
  const app = loadAdmin({
    bootToken: 'tok-1',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=25&page=1': () => respond({ orders: [ORDER], total: 1, page: 1, perPage: 25 }),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.tabs[1]); // exchange
  await app.settle();

  const delBtn = app.all(app.panels.exchange, (n) => n.tagName === 'BUTTON' && n.textContent === 'Delete')[0];
  app.click(delBtn);

  const overlay = app.doc.body.children.find((n) => n.className === 'modal-overlay');
  assert.ok(overlay, 'a confirm overlay is shown');
  assert.equal(
    app.calls.filter((c) => c.url.includes('/o1/delete')).length,
    0,
    'no delete request before confirmation'
  );

  const confirmBtn = app.all(overlay, (n) => n.tagName === 'BUTTON' && n.textContent === 'Confirm')[0];
  app.click(confirmBtn);
  await app.settle();

  const del = app.calls.find((c) => c.url.includes('/o1/delete'));
  assert.ok(del, 'the delete is sent only after confirmation');
  assert.equal(del.options.method, 'POST');
  assert.ok(!app.doc.body.children.some((n) => n.className === 'modal-overlay'), 'overlay removed after confirm');
});

test('cancelling a delete sends nothing', async () => {
  const app = loadAdmin({
    bootToken: 'tok-1',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=25&page=1': () => respond({ orders: [ORDER], total: 1, page: 1, perPage: 25 }),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.tabs[1]);
  await app.settle();

  const delBtn = app.all(app.panels.exchange, (n) => n.tagName === 'BUTTON' && n.textContent === 'Delete')[0];
  app.click(delBtn);
  const overlay = app.doc.body.children.find((n) => n.className === 'modal-overlay');
  const cancelBtn = app.all(overlay, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel')[0];
  app.click(cancelBtn);
  await app.settle();

  assert.ok(!app.calls.some((c) => c.url.includes('/o1/delete')), 'no delete fired on cancel');
  assert.ok(!app.doc.body.children.some((n) => n.className === 'modal-overlay'), 'overlay removed on cancel');
});

test('View opens the order detail modal and Copy uses the clipboard', async () => {
  const app = loadAdmin({
    bootToken: 'tok-1',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=25&page=1': () => respond({ orders: [ORDER], total: 1, page: 1, perPage: 25 }),
      '/api/admin/exchange/orders/o1': () => respond(ORDER_DETAIL),
      '/api/exchange/orders/o1/proof': () => ({ blobBody: { kind: 'fake-image' } }),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.tabs[1]);
  await app.settle();

  const viewBtn = app.all(app.panels.exchange, (n) => n.tagName === 'BUTTON' && n.textContent === 'View')[0];
  assert.ok(viewBtn, 'View is offered on the card');
  app.click(viewBtn);
  await app.settle();
  await app.settle();

  const detailReq = app.calls.find((c) => c.url === '/api/admin/exchange/orders/o1');
  assert.ok(detailReq, 'detail is fetched with Bearer');
  assert.equal(detailReq.options.headers.Authorization, 'Bearer tok-1');

  const overlay = app.doc.body.children.find(
    (n) => n.className === 'modal-overlay' && n.getAttribute('data-admin-order-detail') === '1'
  );
  assert.ok(overlay, 'detail modal opens');
  assert.ok(
    app.all(overlay, (n) => n.tagName === 'DD' && n.textContent.includes('Ada Lovelace')).length >= 1,
    'full account name is shown'
  );
  assert.ok(
    app.all(overlay, (n) => n.tagName === 'CODE' && n.textContent === ORDER_DETAIL.viewToken).length === 1,
    'viewToken is shown'
  );

  const copyBtn = app.all(overlay, (n) => n.tagName === 'BUTTON' && n.textContent === 'Copy')[0];
  app.click(copyBtn);
  await app.settle();
  assert.deepEqual(app.copied, [ORDER_DETAIL.viewToken]);

  const proofReq = app.calls.find((c) => c.url === '/api/exchange/orders/o1/proof');
  assert.ok(proofReq, 'proof is fetched via the public route');
  assert.equal(proofReq.options.headers['X-View-Token'], ORDER_DETAIL.viewToken);
  assert.ok(app.objectUrls.length >= 1, 'a blob URL is created for the proof image');
  assert.ok(
    app.all(overlay, (n) => n.tagName === 'IMG' && n.className === 'ex-proof-img' && n.src).length === 1,
    'proof image is shown'
  );
});

test('exchange orders Apply sends q and pager Next advances page', async () => {
  const app = loadAdmin({
    bootToken: 'tok-1',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=25&page=1': () =>
        respond({ orders: [ORDER], total: 26, page: 1, perPage: 25 }),
      '/api/admin/exchange/orders?perPage=25&page=1&q=Ada': () =>
        respond({ orders: [ORDER], total: 26, page: 1, perPage: 25 }),
      '/api/admin/exchange/orders?perPage=25&page=2&q=Ada': () =>
        respond({
          orders: [{ ...ORDER, id: 'o2', reference: 'SCI-000002', senderName: 'Ada Two' }],
          total: 26,
          page: 2,
          perPage: 25,
        }),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.tabs[1]);
  await app.settle();

  const search = app.all(app.panels.exchange, (n) => n.tagName === 'INPUT' && n.type === 'search')[0];
  assert.ok(search, 'search field is present');
  search.value = 'Ada';
  const apply = app.all(app.panels.exchange, (n) => n.tagName === 'BUTTON' && n.textContent === 'Apply')[0];
  app.click(apply);
  await app.settle();

  assert.ok(
    app.calls.some((c) => c.url === '/api/admin/exchange/orders?perPage=25&page=1&q=Ada'),
    'Apply sends q'
  );
  assert.ok(
    app.all(app.panels.exchange, (n) => n.className === 'muted' && String(n.textContent).includes('Page 1 of 2')).length >= 1,
    'pager info is shown'
  );

  app.calls.length = 0;
  const next = app.all(app.panels.exchange, (n) => n.tagName === 'BUTTON' && n.textContent === 'Next')[0];
  assert.equal(next.disabled, false, 'Next is enabled when more pages exist');
  app.click(next);
  await app.settle();
  assert.ok(
    app.calls.some((c) => c.url === '/api/admin/exchange/orders?perPage=25&page=2&q=Ada'),
    'Next requests page 2 with the same q'
  );
});

test('Escape closes the order detail modal', async () => {
  const app = loadAdmin({
    bootToken: 'tok-1',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=25&page=1': () =>
        respond({ orders: [ORDER], total: 1, page: 1, perPage: 25 }),
      '/api/admin/exchange/orders/o1': () => respond(ORDER_DETAIL),
      '/api/exchange/orders/o1/proof': () => ({ blobBody: { kind: 'fake-image' } }),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.tabs[1]);
  await app.settle();
  const viewBtn = app.all(app.panels.exchange, (n) => n.tagName === 'BUTTON' && n.textContent === 'View')[0];
  app.click(viewBtn);
  await app.settle();
  await app.settle();

  assert.ok(
    app.doc.body.children.some(
      (n) => n.className === 'modal-overlay' && n.getAttribute('data-admin-order-detail') === '1'
    ),
    'detail modal is open'
  );

  const keyHandlers = app.doc.listeners.keydown || [];
  assert.ok(keyHandlers.length >= 1, 'Escape key handler is registered');
  keyHandlers.slice().forEach((fn) => fn({ key: 'Escape' }));
  await app.settle();

  assert.ok(
    !app.doc.body.children.some(
      (n) => n.className === 'modal-overlay' && n.getAttribute('data-admin-order-detail') === '1'
    ),
    'detail modal closes on Escape'
  );
  assert.equal((app.doc.listeners.keydown || []).length, 0, 'Escape listener is removed');
});

test('dashboard filters request from/to/status and render the volume series', async () => {
  const filtered = {
    ...DASHBOARD_BODY,
    stats: {
      ...DASHBOARD_BODY.stats,
      total: 2,
      series: [
        { day: '2026-10-17', count: 2, volumeMmk: 25000, byStatus: { PENDING: 2, APPROVED: 0, COMPLETED: 0, REJECTED: 0 } },
      ],
      filters: { from: '2026-10-17', to: '2026-10-17', status: 'PENDING' },
    },
    filters: { from: '2026-10-17', to: '2026-10-17', status: 'PENDING' },
  };
  const app = loadAdmin({
    bootToken: 'tok-1',
    routes: {
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/dashboard?from=2026-10-17&to=2026-10-17&status=PENDING': () => respond(filtered),
    },
  });
  await app.settle();
  await app.settle();

  assert.ok(
    app.all(app.panels.dashboard, (n) => n.className === 'admin-series-row').length === 2,
    'initial series rows render'
  );
  assert.ok(
    app.all(app.panels.dashboard, (n) => n.className === 'admin-stat-number' && n.textContent.includes('50,000')).length >= 1,
    'total volume card is shown'
  );

  const fromInput = app.all(app.panels.dashboard, (n) => n.tagName === 'INPUT' && n.type === 'date')[0];
  const toInput = app.all(app.panels.dashboard, (n) => n.tagName === 'INPUT' && n.type === 'date')[1];
  const statusSelect = app.all(app.panels.dashboard, (n) => n.tagName === 'SELECT')[0];
  const apply = app.all(app.panels.dashboard, (n) => n.tagName === 'BUTTON' && n.textContent === 'Apply')[0];
  fromInput.value = '2026-10-17';
  toInput.value = '2026-10-17';
  statusSelect.value = 'PENDING';
  app.click(apply);
  await app.settle();
  await app.settle();

  const filteredReq = app.calls.find(
    (c) => c.url === '/api/admin/dashboard?from=2026-10-17&to=2026-10-17&status=PENDING'
  );
  assert.ok(filteredReq, 'Apply reloads the dashboard with filters');
  assert.equal(
    app.all(app.panels.dashboard, (n) => n.className === 'admin-series-row').length,
    1,
    'filtered series renders'
  );
});
