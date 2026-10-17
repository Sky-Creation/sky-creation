/* Netlify Function: contact form -> Brevo transactional email.
 *
 * Route: POST /api/contact  (rewritten to /.netlify/functions/contact)
 *
 * Required environment variables (set in the Netlify UI, never in the repo):
 *   BREVO_API_KEY   Brevo v3 API key (xkeysib-...)
 *   CONTACT_TO      recipient address for form submissions
 * Optional:
 *   CONTACT_FROM    verified Brevo sender (defaults to CONTACT_TO)
 *
 * Anti-abuse: honeypot field, shared Upstash rate limit and a payload size cap.
 * None of these stop a determined attacker; they raise the cost enough that the
 * free tier is not trivially burnable.
 *
 * Every legitimate submission is emailed. Nothing is silently discarded on the
 * way through, because a customer who is told "message sent" must be able to
 * rely on it.
 */

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

const MAX_NAME = 120;
const MAX_EMAIL = 200;
const MAX_SUBJECT = 150;
const MAX_MESSAGE = 4000;
// Largest request body we will even look at. Far above what the form can
// produce (~4.5 KB of fields with the caps above), so it never rejects a real
// message, and small enough that an oversized payload is refused before any
// parsing or allocation happens.
const MAX_BODY_BYTES = 16 * 1024;
import {
  createMemoryRateLimiter,
  createProductionRateLimiter,
  enforceRateLimit,
  resolveRateLimitHmacKey,
  RateLimiterError,
} from './exchange-lib/rate-limit.mjs';

const RATE_LIMIT = { max: 5, windowSeconds: 10 * 60 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function respond(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function clientIp(event) {
  const forwarded = event.headers?.['x-nf-client-connection-ip'];
  if (forwarded) return String(forwarded);
  return String(event.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clean(value, max) {
  // Strip control characters; CRLF in a body field is header-injection bait.
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function createContactHandler({ env = process.env, limiter, allowTestDefault = false } = {}) {
  const chosenLimiter = limiter || createMemoryRateLimiter();
  // Memory-only path (no explicit production limiter) may use the test key;
  // production always passes an Upstash limiter and requires RATE_LIMIT_HMAC_KEY.
  const hmacKey = resolveRateLimitHmacKey(env, {
    allowTestDefault: allowTestDefault || !limiter || String(env.SKY_EXCHANGE_TEST || '') === '1',
  });
  return async (event) => {
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  // Refuse oversized bodies before touching them. This is the only defence
  // that has to run first: everything below reads, parses or copies the body.
  // If Netlify base64-encoded the request the length over-reports slightly,
  // which only makes the check more conservative.
  const raw = typeof event.body === 'string' ? event.body : '';
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    console.log('contact: request body too large, discarded');
    return respond(413, { error: 'Message too large. Please shorten it.' });
  }

  const apiKey = env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEY is not configured');
    return respond(500, { error: 'Server is not configured' });
  }

  const to = clean(env.CONTACT_TO || env.CONTACT_FROM, MAX_EMAIL);
  const from = clean(env.CONTACT_FROM || to, MAX_EMAIL);
  if (!to || !EMAIL_RE.test(to) || !EMAIL_RE.test(from)) {
    console.error('CONTACT_TO / CONTACT_FROM are missing or invalid');
    return respond(500, { error: 'Server is not configured' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid request' });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return respond(400, { error: 'Invalid request' });
  }

  // Honeypot: a filled hidden field means a bot. Report success, send nothing.
  if (clean(body.company, 200)) {
    console.log('contact: honeypot triggered, message discarded');
    return respond(200, { ok: true });
  }

  const name = clean(body.name, MAX_NAME);
  const email = clean(body.email, MAX_EMAIL);
  const subject = clean(body.subject, MAX_SUBJECT);
  const message = String(body.message ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_MESSAGE);

  if (!name || !message || !EMAIL_RE.test(email)) {
    return respond(400, { error: 'Please provide a name, a valid email and a message.' });
  }

  try {
    await enforceRateLimit({
      limiter: chosenLimiter,
      namespace: 'contact',
      ip: clientIp(event),
      max: RATE_LIMIT.max,
      windowSeconds: RATE_LIMIT.windowSeconds,
      hmacKey,
    });
  } catch (err) {
    if (err instanceof RateLimiterError) {
      const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
      return respond(err.status, { error: err.message }, headers);
    }
    console.error('contact: rate limiter failed', err && err.message ? err.message : err);
    return respond(503, { error: 'Service temporarily unavailable' });
  }

  const payload = {
    sender: { email: from, name: 'Sky Creation Innovations' },
    to: [{ email: to, name: 'Sky Creation Innovations' }],
    replyTo: { email, name },
    subject: `[Website] ${subject || `Message from ${name}`}`,
    htmlContent: [
      `<h2>New message from ${escapeHtml(name)}</h2>`,
      `<p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>`,
      subject ? `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>` : '',
      '<hr>',
      `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
    ].join('\n'),
    textContent: [
      `New message from ${name}`,
      `From: ${name} <${email}>`,
      subject ? `Subject: ${subject}` : '',
      '',
      message,
    ].join('\n'),
  };

  let res;
  try {
    res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Brevo request failed:', err?.message || err);
    return respond(502, { error: 'Could not reach the mail provider. Please email us directly.' });
  }

  if (!res.ok) {
    // Log the provider's body, never the API key.
    const detail = await res.text();
    console.error(`Brevo ${res.status}: ${detail.slice(0, 500)}`);
    return respond(502, { error: 'Could not send your message. Please email us directly.' });
  }

  return respond(200, { ok: true });
  };
};

let productionLimiter;
let testLimiter;

export const handler = async (event) => {
  try {
    if (process.env.SKY_EXCHANGE_TEST === '1') {
      testLimiter = testLimiter || createMemoryRateLimiter();
      return await createContactHandler({
        env: process.env,
        limiter: testLimiter,
        allowTestDefault: true,
      })(event);
    }
    productionLimiter = productionLimiter || createProductionRateLimiter(process.env);
    const limiter = await productionLimiter;
    return await createContactHandler({ env: process.env, limiter })(event);
  } catch (err) {
    if (err instanceof RateLimiterError) {
      const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
      return respond(err.status, { error: err.message }, headers);
    }
    console.error('contact: unavailable', err && err.message ? err.message : err);
    return respond(503, { error: 'Service temporarily unavailable' });
  }
};
