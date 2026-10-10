/* Blob storage for the SCI Exchange app.
 *
 * Production uses @netlify/blobs, the KV-ish store attached to the Netlify
 * Functions runtime: the database, proofs and admin sessions all live there so
 * the app stays within Netlify's free tier with no database to run.
 *
 * The function handler is v1 Lambda-style, where Netlify does NOT inject the
 * Blobs environment automatically the way it does for v2 handlers. The runtime
 * instead attaches a base64 blob config to the event, and @netlify/blobs'
 * connectLambda() turns that into the store context getStore() reads. Without
 * it the package looks for a runtime global that v1 never defines and throws
 * "getEnvironmentContext2 is not a function" on the first store open.
 *
 * Blobs default to *eventual* consistency: new keys are readable immediately,
 * but updates and deletions can take up to 60 seconds to propagate. The admin
 * flow does read-then-write transitions (approve -> complete, rate history
 * unshift, order index edits), which under eventual consistency would 400 on
 * the stale previous state. The real store therefore opens with strong
 * consistency. The in-memory test store is always strong by construction, so
 * tests never caught either the JSON-text bug or the eventual-consistency one.
 *
 * Tests inject an InMemoryStore with the same surface and run with
 * SKY_EXCHANGE_TEST=1, which is why the @netlify/blobs import is lazy rather
 * than static: importing exchange.mjs in CI must not require the package.
 */

export async function openStores(event) {
  if (process.env.SKY_EXCHANGE_TEST === '1') {
    return {
      store: new InMemoryStore(),
      proofs: new InMemoryStore(),
      mode: 'memory',
    };
  }

  const { getStore, connectLambda } = await import('@netlify/blobs');
  // v1 only. A v2 handler has no `blobs` payload on the event and relies on
  // runtime globals, so the guard keeps this file valid for both shapes.
  if (event && event.blobs) {
    connectLambda(event);
  }
  return {
    // Strong consistency: without it the update/delete reads around admin
    // transitions can lag up to 60 seconds behind the writes (see header).
    store: new JsonStore(getStore('SCI_EXCHANGE_ORDERS', { consistency: 'strong' })),
    proofs: new JsonStore(getStore('SCI_EXCHANGE_PROOFS', { consistency: 'strong' })),
    mode: 'blobs',
  };
}

function isDangerousKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/* Contract both stores share (this is the part that was broken in prod):
 *
 * - get(key) returns the stored value already parsed from JSON, and
 *   get(key, { type: 'arrayBuffer' }) returns raw bytes.
 * - set(key, object) stores JSON text; set(key, buffer) stores raw bytes.
 *
 * The raw @netlify/blobs Store returns JSON text from get() unless a reading
 * type is passed, so the first live deploy found every order as a string,
 * every read of order.viewToken was undefined, and the redaction never lifted.
 * Packing that behaviour into the wrapper keeps the app code and the test
 * store on one API. */
export class JsonStore {
  constructor(inner, tag) {
    this.inner = inner;
    this.tag = tag;
  }

  async get(key, options = {}) {
    const value =
      options.type === 'arrayBuffer'
        ? await this.inner.get(key, { type: 'arrayBuffer' })
        : await this.inner.get(key, { type: 'json' });
    return value === null || value === undefined ? null : value;
  }

  async set(key, value, options = {}) {
    if (isDangerousKey(key)) throw new Error(`blocked key: ${key}`);
    if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      await this.inner.set(key, value);
    } else {
      await this.inner.set(key, JSON.stringify(value));
    }
    return options;
  }

  async delete(key) {
    return this.inner.delete(key);
  }

  async list(options = {}) {
    // The raw store returns { blobs, directories }; the app and the test store
    // both expect the plain array. Normalise here so adminAudit's
    // item.key mapping does not blow up on the real shape.
    const result = await this.inner.list(options);
    return Array.isArray(result) ? result : result.blobs || [];
  }
}

/* In-memory stand-in with the same surface as JsonStore, sufficient for tests. */
export class InMemoryStore {
  constructor() {
    this.data = new Map();
  }

  async get(key, options = {}) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    if (options.type === 'arrayBuffer') {
      const bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value === null || value === undefined ? '' : String(value));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  async set(key, value, options = {}) {
    if (isDangerousKey(key)) throw new Error(`blocked key: ${key}`);
    this.data.set(key, Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return options;
  }

  async delete(key) {
    this.data.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    const keys = Array.from(this.data.keys())
      .filter((key) => key.startsWith(prefix))
      .sort();
    return keys.map((key) => ({ key }));
  }
}

export async function readJson(store, key) {
  const value = await store.get(key);
  if (value === null || value === undefined) return null;
  return value;
}

export async function writeJson(store, key, value) {
  await store.set(key, value);
}

export async function readBinary(store, key) {
  const value = await store.get(key, { type: 'arrayBuffer' });
  return value === null ? null : Buffer.from(value);
}

export async function writeBinary(store, key, buffer) {
  await store.set(key, buffer);
}