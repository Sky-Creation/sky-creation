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
    store: getStore('SCI_EXCHANGE_ORDERS'),
    proofs: getStore('SCI_EXCHANGE_PROOFS'),
    mode: 'blobs',
  };
}

function isDangerousKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/* In-memory stand-in, sufficient for tests: JSON values and raw binary. */
export class InMemoryStore {
  constructor() {
    this.data = new Map();
  }

  async get(key, options = {}) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    if (options.type === 'arrayBuffer' && value.byteLength !== undefined) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return value;
  }

  async getBinary(key) {
    const value = this.data.get(key);
    if (value === undefined || value.byteLength === undefined) return null;
    return Buffer.from(value);
  }

  async set(key, value, opts = {}) {
    if (isDangerousKey(key)) throw new Error(`blocked key: ${key}`);
    this.data.set(key, JSON.parse(JSON.stringify(value)));
    return opts;
  }

  async setBinary(key, buffer) {
    if (isDangerousKey(key)) throw new Error(`blocked key: ${key}`);
    this.data.set(key, Buffer.from(buffer));
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
  const buf = await store.getBinary(key);
  return buf === null ? null : Buffer.from(buf);
}

export async function writeBinary(store, key, buffer) {
  await store.setBinary(key, buffer);
}