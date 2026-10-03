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
 * Run: node --test site/test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'assets', 'main.js'), 'utf8');

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

  const fetchImpl = (url, opts) => {
    calls.fetch.push({ url, body: JSON.parse(opts.body) });
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