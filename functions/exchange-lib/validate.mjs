/* Input validation and sanitisation shared by the exchange handlers.
 *
 * These mirror the guarantees the classifier app relies on: amounts must be
 * real finite numbers (JSON.parse turns "1e309" into Infinity, so a zero-cost
 * bypass is a cost-free way to probe the app), every free-text field is
 * capped, control characters are stripped so nothing later logged or rendered
 * can smuggle in markup or CRLF, and recognised prototype-pollution keys are
 * rejected outright.
 */

import { createHash } from 'node:crypto';

export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MAX_PROOF_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_ORDER_AMOUNT = 10 ** 9;
export const MIN_THB_TO_MMK_RATE = 50;
export const MAX_THB_TO_MMK_RATE = 500;

const MAX_SENDER_NAME = 120;
const MAX_SENDER_CONTACT = 200;
const MAX_ACCOUNT_NO = 64;
const MAX_ACCOUNT_NAME = 120;
const MAX_NOTE = 1000;
const MAX_METHOD = 64;

export const MAX_POST_TEXT = 4000;
export const MAX_POST_URL = 2000;
export const POST_LISTS = new Set(['company', 'math']);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const DIRECTIONS = new Set(['THB_TO_MMK', 'MMK_TO_THB']);
export const LEVELS = new Set(['Standard', 'Express', 'VIP']);
export const ORDER_STATUSES = new Set([
  'PENDING',
  'APPROVED',
  'COMPLETED',
  'REJECTED',
]);

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_INPUT';
  }
}

export function isValidThbToMmkRate(value) {
  return isFiniteNumber(value) && value >= MIN_THB_TO_MMK_RATE && value <= MAX_THB_TO_MMK_RATE;
}

/* Strip CR/LF/control characters (header-injection and markup bait), trim,
 * then truncate. Mirrors functions/contact.mjs's clean(). */
export function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/* Returns true and logs nothing when the payload is safe, otherwise throws a
 * descriptive error. Rejects dangerous keys one level deep, which covers both
 * the request body and nested objects such as { orders: [...] }. */
export function assertSafeKeys(payload, path = '$') {
  const seen = new Set();
  function walk(value, where) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (BLOCKED_KEYS.has(key)) {
        throw new ValidationError(`unsafe object key "${key}" at ${where}`);
      }
      const next = value[key];
      if (next !== null && typeof next === 'object') {
        walk(next, `${where}.${key}`);
      }
    }
  }
  walk(payload, path);
}

/* Parse the request body as JSON. Handles Netlify's base64 encoding, enforces
 * a byte cap before parsing, and applies the pollution-key rule. */
export function parseJsonBody(event, maxBytes = MAX_JSON_BODY_BYTES) {
  const raw = typeof event.body === 'string' ? event.body : '';
  const text = event.isBase64Encoded
    ? Buffer.from(raw, 'base64').toString('utf8')
    : raw;

  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const err = new ValidationError('Request body too large');
    err.code = 'TOO_LARGE';
    throw err;
  }

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    const err = new ValidationError('Invalid JSON body');
    err.code = 'INVALID_JSON';
    throw err;
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    const err = new ValidationError('Body must be a JSON object');
    err.code = 'INVALID_BODY';
    throw err;
  }

  try {
    assertSafeKeys(body);
  } catch (err) {
    err.code = 'UNSAFE_KEYS';
    throw err;
  }
  return body;
}

export function parseOrderInput(body) {
  const direction = cleanText(body.direction, 32).toUpperCase();
  if (!DIRECTIONS.has(direction)) {
    throw new ValidationError('direction must be one of: THB_TO_MMK, MMK_TO_THB');
  }

  const amount = body.amount;
  if (!isFiniteNumber(amount) || amount <= 0 || amount > MAX_ORDER_AMOUNT) {
    throw new ValidationError('amount must be a finite number greater than zero');
  }

  const level = cleanText(body.level, 32);
  if (!LEVELS.has(level)) {
    throw new ValidationError('level is invalid');
  }

  const method = cleanText(body.method, MAX_METHOD);
  if (!method) throw new ValidationError('method is required');
  if (method.length > MAX_METHOD) throw new ValidationError('method is too long');

  const senderName = cleanText(body.senderName, MAX_SENDER_NAME);
  const senderContact = cleanText(body.senderContact, MAX_SENDER_CONTACT);
  if (!senderName || !senderContact) {
    throw new ValidationError('senderName and senderContact are required');
  }

  return {
    direction,
    amount,
    level,
    method,
    senderName,
    senderContact,
    accountNo: cleanText(body.accountNo, MAX_ACCOUNT_NO),
    accountName: cleanText(body.accountName, MAX_ACCOUNT_NAME),
    note: String(body.note ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_NOTE),
  };
}

export function parseRateInput(body) {
  const rate = body.thbToMmk;
  if (!isValidThbToMmkRate(rate)) {
    throw new ValidationError(`thbToMmk must be between ${MIN_THB_TO_MMK_RATE} and ${MAX_THB_TO_MMK_RATE}`);
  }
  return { thbToMmk: rate };
}

/* Parse a Facebook post in either list: { date, text, url? }. date must be an
 * ISO calendar date, text 1..4000 characters, url optional and http(s). */
export function parsePostInput(body) {
  const date = cleanText(body.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError('date must be a YYYY-MM-DD calendar date');
  }
  const when = new Date(`${date}T00:00:00Z`);
  if (isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== date) {
    throw new ValidationError('date is not a real calendar date');
  }

  const text = String(body.text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!text) throw new ValidationError('text is required');
  if (text.length > MAX_POST_TEXT) throw new ValidationError('text is too long');

  const url = cleanText(body.url, MAX_POST_URL);
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) {
    throw new ValidationError('url must be an http(s) link');
  }

  return { date, text, url };
}

/* Read a proof payload: { mimeType, fileName?, dataBase64 }.
 * The decoded size is what matters, so the base64 string is decoded before the
 * cap is compared against, not after. */
export function parseProofInput(body) {
  const mimeType = cleanText(body.mimeType, 64).toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new ValidationError('mimeType must be image/jpeg, image/png or image/webp');
  }

  const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
  if (!dataBase64) throw new ValidationError('dataBase64 is required');

  const encoded = dataBase64.replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ValidationError('dataBase64 is not valid base64');
  }

  let buffer;
  try {
    buffer = Buffer.from(encoded, 'base64');
  } catch {
    throw new ValidationError('dataBase64 is not valid base64');
  }
  if (buffer.byteLength === 0 || buffer.byteLength > 5 * 1024 * 1024) {
    throw new ValidationError('proof must be between 1 byte and 5 MB');
  }

  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if ((mimeType === 'image/jpeg' && !isJpeg) || (mimeType === 'image/png' && !isPng) || (mimeType === 'image/webp' && !isWebp)) {
    throw new ValidationError('proof bytes do not match the declared image type');
  }

  return {
    mimeType,
    fileName: cleanText(body.fileName, 120),
    buffer,
  };
}

export function safeHashOf(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12);
}
