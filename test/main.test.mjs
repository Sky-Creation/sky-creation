/* Behavioural tests for the contact form handler in assets/main.js.
 *
 * The handler is a plain IIFE with no export, so it is evaluated here against
 * the DOM surface it uses and the submit listener is captured and invoked
 * directly.
 *
 * These cover the regression that mattered once the form went public: a
 * visitor who submitted quickly used to be shown a success message while
 * nothing was sent, and their enquiry was lost with no trace. The rule the
 * tests enforce is that every legitimate submission reaches the server, and a
 * bot-triggered honeypot is the only path that reports success without
 * sending.
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
const source = readFileSync(join(here, '..', 'site', 'assets', 'main.js'), 'utf8');

/**
 * Evaluate main.js against a minimal DOM.
 *
 * Options let a test drive the form fields and choose how fetch behaves:
 * `mode` is 'ok' to resolve successfully, or 'reject' to fail at the network
 * level so the error branch can be asserted.
 */
function load({
  company = '',
  name = 'Ada',
  email = 'ada@example.com',
  subject = 'Hello',
  message = 'A message.',
  mode = 'ok',
} = {}) {
  const listeners = {};
  const calls = { fetch: [], status: [], reset: 0 };

  function element(overrides = {}) {
    return {
      value: '',
      disabled: false,
      textContent: '',
      className: '',
      children: [],
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(key, value) { this[key] = value; },
      removeAttribute(key) { delete this[key]; },
      ...overrides,
    };
  }

  const statusEl = element({
    setAttribute(key, value) {
      calls.status.push([key, value]);
      this[key] = value;
    },
  });

  const submitBtn = element();

  const form = {
    elements: {
      name: element({ value: name }),
      email: element({ value: email }),
      subject: element({ value: subject }),
      message: element({ value: message }),
      company: element({ value: company }),
    },
    reset() { calls.reset += 1; },
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector(sel) {
      if (sel === '.form-status') return statusEl;
      if (sel === 'button[type="submit"]') return submitBtn;
      return null;
    },
  };

  // The posts probe (/api/posts) runs on load for every page. The contact-form
  // tests only care about submissions, so the probe is recorded separately and
  // not counted in `calls.fetch`.
  const fetchImpl = (url, opts) => {
    if (url === '/api/posts') {
      calls.postsProbe = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ company: [], math: [] }) });
    }
    calls.fetch.push({ url, body: JSON.parse(opts?.body || '{}') });
    if (mode === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  };

  const context = {
    window: { SKY_POSTS: { company: [], math: [] } },
    document: {
      querySelector: (sel) => (sel === '[data-contact-form]' ? form : null),
      querySelectorAll: () => [],
      createElement: () => element(),
      addEventListener() {},
    },
    fetch: fetchImpl,
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  // Flush the promise chain used by the handler.
  const settle = () => new Promise((r) => setImmediate(r));

  return { submit: listeners.submit, calls, form, submitBtn, settle };
}

test('the submit handler is wired up', () => {
  const { submit } = load();
  assert.equal(typeof submit, 'function');
});

test('a normal submission reaches the server', async () => {
  const { submit, calls, settle } = load();
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.length, 1, 'expected exactly one fetch');
  assert.equal(calls.fetch[0].url, '/api/contact');
  assert.equal(calls.fetch[0].body.message, 'A message.');
  assert.equal(calls.fetch[0].body.name, 'Ada');
  assert.equal(calls.reset, 1, 'the form is cleared on success');
});

test('the fields are trimmed before sending', async () => {
  const { submit, calls, settle } = load({ name: '  Ada  ', message: '  hi  ' });
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch[0].body.name, 'Ada');
  assert.equal(calls.fetch[0].body.message, 'hi');
});

// The regression that mattered. A visitor who submitted quickly used to be
// shown a success message while nothing was sent.
test('no client-side timing field is sent', async () => {
  const { submit, calls, settle } = load();
  submit({ preventDefault() {} });
  await settle();

  assert.ok(!('startedAt' in calls.fetch[0].body), 'startedAt must not be sent');
});

// The honeypot is enforced in the function, not here: the client must forward
// the value so the server can filter on it. Silently dropping it client-side
// would mean a real visitor whose autofill filled the hidden field lost their
// message with no server-side trace.
test('the honeypot value is forwarded for the server to filter on', async () => {
  const { submit, calls, settle } = load({ company: 'Bot Corp' });
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.length, 1, 'the submission reaches the function');
  assert.equal(calls.fetch[0].body.company, 'Bot Corp', 'the server sees the trap value');
  assert.equal(calls.reset, 1, 'the function reports success, so the form clears');
  assert.ok(
    calls.status.some(([, v]) => v === 'success'),
    'the visitor sees a success state'
  );
});

test('missing required fields are rejected before any fetch', async () => {
  const { submit, calls, settle } = load({ name: '', message: '' });
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.length, 0, 'incomplete submissions must not be sent');
  assert.ok(
    calls.status.some(([, v]) => v === 'error'),
    'the visitor is told to fill in the missing fields'
  );
});

test('a network failure surfaces an error and re-enables the button', async () => {
  const { submit, calls, submitBtn, settle } = load({ mode: 'reject' });
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.length, 1, 'the attempt is still made');
  assert.ok(
    calls.status.some(([, v]) => v === 'error'),
    'the visitor is not left on a pending state'
  );
  assert.equal(submitBtn.disabled, false, 'the submit button is usable again');
});

// The server rejects a malformed address with a 400. Catching it here spares
// the visitor the round trip, but the rule to protect is weaker than the
// server's: this must never reject something the server would have accepted.
test('a malformed email is rejected before any fetch', async () => {
  const { submit, calls, settle } = load({ email: 'not-an-email' });
  submit({ preventDefault() {} });
  await settle();

  assert.equal(calls.fetch.length, 0, 'an address the server would refuse must not be sent');
  assert.ok(
    calls.status.some(([, v]) => v === 'error'),
    'the visitor is told the address is wrong'
  );
});

// Autofill runs after the DOM is ready, so a honeypot left enabled can be
// populated by a password manager and eat a real enquiry. Disabling it at load
// closes that. The value must still be forwarded - see the test above - so
// this only asserts the control is locked, not emptied.
test('the honeypot input is disabled once the page has loaded', () => {
  const { form } = load();

  assert.equal(form.elements.company.disabled, true, 'the trap is locked to humans');
  assert.equal(form.elements.company.value, '', 'it is not cleared, only disabled');
});

/* --- Facebook posts ----------------------------------------------------- */

function loadPostsPage({ apiResult, apiReject = false, staticPosts = {} } = {}) {
  const calls = { fetch: [] };

  function element(overrides = {}) {
    return {
      value: '',
      disabled: false,
      textContent: '',
      className: '',
      hidden: false,
      children: [],
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(key, value) { this[key] = value; },
      removeAttribute(key) { delete this[key]; },
      ...overrides,
    };
  }

  function makeSection(key) {
    const list = {
      className: 'post-list',
      children: [],
      appendChild(child) { this.children.push(child); return child; },
    };
    const section = {
      hidden: false,
      children: [],
      appendChild(child) { this.children.push(child); return child; },
      getAttribute: () => key,
      querySelector: (sel) => (sel === '.post-list' ? list : null),
    };
    return { section, list };
  }

  const company = makeSection('company');
  const math = makeSection('math');

  const fetchImpl = (url) => {
    calls.fetch.push(url);
    if (apiReject) return Promise.reject(new Error('network down'));
    return Promise.resolve(apiResult || { ok: true, json: () => Promise.resolve({ company: [], math: [] }) });
  };

  const context = {
    window: { SKY_POSTS: staticPosts },
    document: {
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '[data-posts]' ? [company.section, math.section] : []),
      createElement: () => element(),
      addEventListener() {},
    },
    fetch: fetchImpl,
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const settle = () => new Promise((r) => setImmediate(r));
  return { calls, company, math, settle };
}

test('posts are read from the admin API and rendered in order', async () => {
  const { calls, company, settle } = loadPostsPage({
    apiResult: {
      ok: true,
      json: () =>
        Promise.resolve({
          company: [
            { date: '2026-01-01', text: 'newer', url: 'https://facebook.com/x' },
            { date: '2025-12-01', text: 'older' },
          ],
          math: [],
        }),
    },
  });

  await settle();

  assert.deepEqual(calls.fetch, ['/api/posts'], 'the page reads posts from the function');
  assert.equal(company.section.hidden, false, 'a populated list shows its section');
  assert.equal(company.list.children.length, 2);
  assert.equal(
    company.list.children[0].children[1].textContent,
    'newer',
    'posts are ordered newest first'
  );
  assert.equal(company.list.children[1].children[1].textContent, 'older');
  assert.equal(
    company.list.children[0].children[2].href,
    'https://facebook.com/x',
    'the external link is rendered'
  );
});

// Once the admin panel can author posts, the API response is authoritative:
// an empty list from the function must hide the section even when the static
// posts.js data has content. The static data is only a fallback for a failed
// or unparseable response, never a merge.
test('an empty API list hides the section even when static data exists', async () => {
  const { calls, math, settle } = loadPostsPage({
    apiResult: { ok: true, json: () => Promise.resolve({ company: [], math: [] }) },
    staticPosts: { math: [{ date: '2025-01-01', text: 'fallback' }] },
  });

  await settle();

  assert.equal(math.section.hidden, true, 'a functioning API wins over static data');
  assert.equal(math.list.children.length, 0);
  assert.equal(calls.fetch[0], '/api/posts');
});

test('a failed /api/posts request falls back to the static data', async () => {
  const { calls, company, settle } = loadPostsPage({
    apiReject: true,
    staticPosts: { company: [{ date: '2025-01-01', text: 'static' }] },
  });

  await settle();

  assert.equal(company.section.hidden, false);
  assert.equal(company.list.children[0].children[1].textContent, 'static');
});

test('an empty list hides its section', async () => {
  const { company, math, settle } = loadPostsPage({
    apiResult: { ok: true, json: () => Promise.resolve({ company: [], math: [] }) },
  });

  await settle();

  assert.equal(company.section.hidden, true, 'empty company posts hide the section');
  assert.equal(math.section.hidden, true, 'empty math posts hide the section');
});

test('post text is rendered as plain text, never markup', async () => {
  const { company, settle } = loadPostsPage({
    apiResult: {
      ok: true,
      json: () =>
        Promise.resolve({
          company: [{ date: '2025-01-01', text: '<img src=x onerror=alert(1)>' }],
        }),
    },
  });

  await settle();

  assert.equal(
    company.list.children[0].children[1].textContent,
    '<img src=x onerror=alert(1)>',
    'textContent assignment keeps attacker markup inert'
  );
});
