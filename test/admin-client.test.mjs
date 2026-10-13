/* Behavioural tests for the admin panel client (site/assets/admin.js).
 *
 * The script is a plain IIFE with no export, so it is evaluated against a
 * hand-built DOM (login view, admin view, six panels, tab buttons) inside a
 * Node vm, with a fake localStorage and a scriptable fetch. The same
 * approach as exchange-client.test.mjs, just a bigger surface.
 *
 * The invariants that matter client-side:
 *   - a login only "succeeds" after the server answers (no timing gate, no
 *     local success); the honeypot is server-side and out of scope here.
 *   - the access token lives in localStorage, is sent as a Bearer header, and
 *     a 401 anywhere drops it and returns to the login screen.
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
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    className: '',
    textContent: '',
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

/** Routes: map of exact url -> (options) => body | {status, body}. */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options: options || {} });
    const route = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : null;
    if (!route) return Promise.resolve(respond({ error: 'unexpected route ' + url }, 404));
    const out = route(options || {}, url);
    return Promise.resolve(
      typeof out.status === 'number' ? respond(out.body, out.status) : respond(out)
    );
  };
  return { calls, fetchImpl };
}

const DASHBOARD_BODY = {
  stats: { total: 5, counts: { PENDING: 2, APPROVED: 1, COMPLETED: 1, REJECTED: 1 }, pendingVolume: 12850 },
  rate: { thbToMmk: 128.5, open: true },
  posts: { company: 1, math: 0 },
  recentAudit: [],
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

function build() {
  // --- DOM ---------------------------------------------------------------
  const doc = {
    readyState: 'complete',
    body: makeEl('body'),
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

  // --- storage -----------------------------------------------------------
  const data = new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };

  return { doc, loginView, adminView, loginForm, loginSubmit, loginStatus, logoutBtn, tabs, panels, localStorage };
}

function loadAdmin({ token = null, routes = {} } = {}) {
  const { doc, loginView, adminView, loginForm, loginSubmit, loginStatus, logoutBtn, tabs, panels, localStorage } = build();
  const make = makeFetch(routes);
  make.routes = routes;
  if (token) localStorage.setItem('sky_admin_token', token);

  const context = {
    window: { localStorage },
    document: doc,
    fetch: make.fetchImpl,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
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
    localStorage,
  };
}

test('with no stored token the login screen is shown and nothing is fetched', () => {
  const app = loadAdmin();
  assert.equal(app.loginView.hidden, false, 'login view is visible');
  assert.equal(app.adminView.hidden, true, 'admin view stays hidden');
  assert.equal(app.calls.length, 0, 'no session probe runs without a token');
});

test('a failed login shows the server error and keeps the session absent', async () => {
  const app = loadAdmin({
    routes: {
      '/api/admin/login': () => ({ status: 401, body: { error: 'Check your password.' } }),
    },
  });

  app.loginForm.elements.identifier.value = 'admin';
  app.loginForm.elements.password.value = 'wrong';
  app.click(app.loginForm, 'submit');
  await app.settle();

  assert.match(app.loginStatus.textContent, /password/i);
  assert.equal(app.loginView.hidden, false, 'still on the login screen');
  assert.equal(app.localStorage.getItem('sky_admin_token'), null, 'no token stored');
});

test('a successful login stores the token, opens the dashboard and sends it as Bearer', async () => {
  const app = loadAdmin({
    routes: {
      '/api/admin/login': () => respond({ accessToken: 'tok-123', role: 'manager' }),
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
    },
  });

  app.loginForm.elements.identifier.value = 'admin';
  app.loginForm.elements.password.value = 'hunter2';
  app.click(app.loginForm, 'submit');
  await app.settle();
  await app.settle();

  assert.equal(app.localStorage.getItem('sky_admin_token'), 'tok-123');
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

test('a valid stored token boots straight into the dashboard', async () => {
  const app = loadAdmin({
    token: 'tok-keep',
    routes: {
      '/api/admin/session': () => respond({ id: 'u1', username: 'admin', email: 'contact@skycreation.dev' }),
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

test('an expired stored token falls back to login and is dropped', async () => {
  const app = loadAdmin({
    token: 'expired',
    routes: {
      '/api/admin/session': () => ({ status: 401, body: { error: 'Session expired' } }),
    },
  });
  await app.settle();

  assert.equal(app.localStorage.getItem('sky_admin_token'), null, 'the dead token is removed');
  assert.equal(app.loginView.hidden, false);
  assert.equal(app.adminView.hidden, true);
});

test('a 401 during normal use drops the token and returns to login', async () => {
  const app = loadAdmin({
    token: 'tok-live',
    routes: {
      '/api/admin/session': () => respond({ id: 'u1', username: 'admin', email: 'contact@skycreation.dev' }),
      '/api/admin/dashboard': () => ({ status: 401, body: { error: 'Session expired' } }),
    },
  });
  await app.settle();
  await app.settle();

  assert.equal(app.localStorage.getItem('sky_admin_token'), null);
  assert.equal(app.loginView.hidden, false);
  assert.equal(app.adminView.hidden, true);
  assert.match(app.loginStatus.textContent, /expired/i);
});

test('logout clears the token and shows the login view', async () => {
  const app = loadAdmin({
    token: 'tok-live',
    routes: {
      '/api/admin/session': () => respond({ id: 'u1' }),
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/logout': () => respond({}),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.logoutBtn);
  await app.settle();

  assert.equal(app.localStorage.getItem('sky_admin_token'), null);
  assert.equal(app.loginView.hidden, false);
  assert.equal(app.adminView.hidden, true);
});

test('the exchange module lists orders from the API', async () => {
  const app = loadAdmin({
    token: 'tok-1',
    routes: {
      '/api/admin/session': () => respond({ id: 'u1' }),
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=100': () => respond({ orders: [ORDER] }),
    },
  });
  await app.settle();
  await app.settle();

  app.click(app.tabs[1]); // exchange
  await app.settle();

  const req = app.calls.find((c) => c.url.startsWith('/api/admin/exchange/orders'));
  assert.equal(req.url, '/api/admin/exchange/orders?perPage=100');
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
    token: 'tok-1',
    routes: {
      '/api/admin/session': () => respond({ id: 'u1' }),
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=100': () => respond({ orders: [ORDER] }),
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
  assert.equal(app.calls.length, 3, 'no delete request before confirmation');

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
    token: 'tok-1',
    routes: {
      '/api/admin/session': () => respond({ id: 'u1' }),
      '/api/admin/dashboard': () => respond(DASHBOARD_BODY),
      '/api/admin/exchange/orders?perPage=100': () => respond({ orders: [ORDER] }),
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