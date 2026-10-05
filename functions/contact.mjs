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
 * Anti-abuse: honeypot field, per-instance rate limit and a payload size cap.
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
const RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

/** Per warm-instance memory, so limits are approximate across a fleet. */
const submissions = new Map();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  };
}

function clientIp(event) {
  const forwarded = event.headers?.['x-nf-client-connection-ip'];
  if (forwarded) return String(forwarded);
  return String(event.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (submissions.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);

  if (hits.length >= RATE_LIMIT.max) {
    submissions.set(ip, hits);
    return true;
  }

  hits.push(now);
  submissions.set(ip, hits);

  // Keep the map from growing without bound on a long-lived instance.
  if (submissions.size > 5000) {
    for (const [key, times] of submissions) {
      if (times.every((t) => now - t >= RATE_LIMIT.windowMs)) submissions.delete(key);
    }
  }
  return false;
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

export const handler = async (event) => {
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

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEY is not configured');
    return respond(500, { error: 'Server is not configured' });
  }

  const to = clean(process.env.CONTACT_TO || process.env.CONTACT_FROM, MAX_EMAIL);
  const from = clean(process.env.CONTACT_FROM || to, MAX_EMAIL);
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

  if (rateLimited(clientIp(event))) {
    return respond(429, { error: 'Too many messages. Please try again later.' });
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
