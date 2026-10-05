/* Tests for the contact function's request handling.
 *
 * The handler is loaded with a stubbed fetch so no real email is sent. What is
 * asserted here is the promise the function makes to a visitor: either the
 * message is handed to the mail provider, or the visitor is given an error
 * they can act on. The only success-without-sending path is the honeypot.
 *
 * Run: node --test test/*.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, '..', 'functions', 'contact.mjs');

/**
 * Import the function with the environment and network under test control.
 *
 * `provider` is 'accept' or 'reject' to choose how the mail provider responds,
 * and `key` controls whether BREVO_API_KEY is present so the unconfigured
 * branch can be exercised. The module is cached by Node, so each case gets a
 * distinct query string to force a fresh evaluation.
 */
let sequence = 0;
async function load({ provider = 'accept', key = 'test-key', to = 'contact@skycreation.dev' } = {}) {
  const sent = [];
  const logs = [];

  // Swap only the members under test and restore them afterwards, rather than
  // replacing whole globals, so the module loader keeps working.
  const realFetch = globalThis.fetch;
  const realLog = console.log;

  globalThis.fetch = (url, opts) => {
    if (provider === 'reject') return Promise.reject(new Error('network down'));
    sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return Promise.resolve({
      ok: true,
      status: 201,
      text: () => Promise.resolve('{"messageId":"<x@y>"}'),
    });
  };
  console.log = (...args) => logs.push(args.join(' '));

  const savedEnv = {};
  const applyEnv = (name, value) => {
    if (value === undefined) return;
    savedEnv[name] = process.env[name];
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  };
  applyEnv('BREVO_API_KEY', key);
  applyEnv('CONTACT_TO', to);

  const restore = () => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  try {
    sequence += 1;
    const mod = await import(`${pathToFileURL(modulePath).href}?case=${sequence}`);
    return {
      handler: mod.handler,
      sent,
      logs,
      restore,
    };
  } catch (err) {
    restore();
    throw err;
  }
}

const ok = (extra = {}) => ({
  body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', message: 'Hello there.' }),
  headers: { 'x-nf-client-connection-ip': '203.0.113.10' },
  httpMethod: 'POST',
  ...extra,
});

test('the module exposes a handler', async () => {
  const { handler } = await load();
  assert.ok(handler, 'expected a handler export from contact.mjs');
});

test('a valid submission is emailed and reports success', async () => {
  const { handler, sent } = await load();
  const res = await handler(ok());
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(sent.length, 1, 'the provider was called');
  assert.equal(sent[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(sent[0].body.to[0].email, 'contact@skycreation.dev');
  assert.equal(sent[0].body.replyTo.email, 'ada@example.com', 'replies go to the sender');
});

// The core regression: no timing gate may return success without sending.
test('a submission sent immediately is still emailed', async () => {
  const { handler, sent } = await load();
  // A startedAt in the past used to short-circuit to {ok:true} with no send.
  const res = await handler(ok());
  await Promise.resolve();

  assert.equal(sent.length, 1, 'a fast submit must not be discarded');
  assert.equal(res.statusCode, 200);
});

test('the honeypot reports success without emailing, and logs it', async () => {
  const { handler, sent, logs } = await load();
  const res = await handler(ok({ body: JSON.stringify({ name: 'Bot', email: 'b@x.com', message: 'spam', company: 'Bot Corp' }) }));

  assert.equal(res.statusCode, 200, 'bots are not told they failed');
  assert.equal(sent.length, 0, 'nothing is emailed');
  assert.ok(
    logs.some((l) => l.includes('honeypot')),
    'the discard is recorded so it is not invisible'
  );
});

test('missing fields are rejected', async () => {
  const { handler, sent } = await load();
  const res = await handler(ok({ body: JSON.stringify({ name: '', email: 'x', message: '' }) }));

  assert.equal(res.statusCode, 400);
  assert.equal(sent.length, 0);
});

test('an invalid email is rejected', async () => {
  const { handler, sent } = await load();
  const res = await handler(ok({ body: JSON.stringify({ name: 'Ada', email: 'not-an-email', message: 'hi' }) }));

  assert.equal(res.statusCode, 400);
  assert.equal(sent.length, 0);
});

test('a provider failure becomes a 502, not a false success', async () => {
  const { handler } = await load({ provider: 'reject' });
  const res = await handler(ok());

  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /email us directly/i);
});

test('a missing API key is reported as a configuration error', async () => {
  const { handler, sent } = await load({ key: null });
  const res = await handler(ok());

  assert.equal(res.statusCode, 500);
  assert.equal(sent.length, 0);
});

test('a non-POST request is refused', async () => {
  const { handler, sent } = await load();
  const res = await handler(ok({ httpMethod: 'GET' }));

  assert.equal(res.statusCode, 405);
  assert.equal(sent.length, 0);
});

test('repeated submissions from one IP are rate limited', async () => {
  const { handler } = await load();
  const event = ok();
  let limited = 0;

  for (let i = 0; i < 8; i += 1) {
    const res = await handler(event);
    if (res.statusCode === 429) limited += 1;
  }

  assert.ok(limited > 0, 'expected the per-IP limit to engage');
});

test('the API key is never echoed into the email body', async () => {
  const { handler, sent } = await load({ key: 'super-secret-key' });
  await handler(ok());

  assert.ok(!JSON.stringify(sent[0].body).includes('super-secret-key'));
});

// The size guard has to run before JSON.parse, otherwise a megabyte of junk is
// allocated and parsed just to be thrown away. It must also be a refusal the
// caller can see, not a 500.
test('an oversized body is refused before it is parsed', async () => {
  const { handler, sent, logs } = await load();
  const res = await handler(ok({ body: 'x'.repeat(64 * 1024) }));

  assert.equal(res.statusCode, 413, 'a too-large request is a 413, not a 500');
  assert.equal(sent.length, 0, 'nothing is emailed');
  assert.ok(
    logs.some((l) => l.includes('too large')),
    'the discard is logged like the honeypot is'
  );
});

// The cap sits far above what the form can send, so a legitimately long
// message (4000-character body plus name/email/subject) still goes through.
test('a message at the field caps is still accepted', async () => {
  const { handler, sent } = await load();
  const res = await handler(
    ok({
      body: JSON.stringify({
        name: 'A'.repeat(120),
        email: 'ada@example.com',
        subject: 'S'.repeat(150),
        message: 'M'.repeat(4000),
      }),
    })
  );

  assert.equal(res.statusCode, 200, 'the guard must not reject a real message');
  assert.equal(sent.length, 1);
});

// A malformed but small body is still a 400, not a 413: size and syntax are
// separate checks and neither may swallow the other.
test('a small malformed body is still reported as invalid', async () => {
  const { handler, sent } = await load();
  const res = await handler(ok({ body: '{not json' }));

  assert.equal(res.statusCode, 400);
  assert.equal(sent.length, 0);
});
