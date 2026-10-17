/* Shared HTTP plumbing for the Netlify Functions.
 *
 * Small enough to live in the exchange-lib tree: the public exchange export
 * (functions/exchange.mjs) and the site-wide admin export
 * (functions/admin.mjs) both build responses and both parse the original
 * request path the same way. Keeping the helpers here means a response header
 * change has exactly one place to land.
 */

export function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

export function ok(payload, extraHeaders) {
  return json(200, payload, extraHeaders);
}

export function fail(statusCode, message, extraHeaders) {
  return json(statusCode, { error: message }, extraHeaders);
}

/* An error the route() dispatch recognises: any Error with a .status becomes
 * fail(status, message) in the catch block, so handlers can throw httpError
 * and let the dispatcher own the response. */
export function httpError(statusCode, message) {
  const err = new Error(message);
  err.status = statusCode;
  return err;
}

export function clientIp(event) {
  const forwarded = event.headers?.['x-nf-client-connection-ip'];
  if (forwarded) return String(forwarded);
  return String(event.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

export function pathOf(event) {
  const q = event.queryStringParameters || {};
  // Some hosts expose the function URL rather than the original path; the
  // rewrite in netlify.toml can carry the subpath here as a fallback.
  if (typeof q.__exchange_path === 'string' && q.__exchange_path) {
    return q.__exchange_path;
  }
  return event.path || '';
}
