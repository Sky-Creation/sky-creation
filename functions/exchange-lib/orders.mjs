/* Shared domain core for the SCI Exchange.
 *
 * Both Netlify Functions use this: functions/exchange.mjs owns the PUBLIC
 * /api/exchange/* surface (rates, calculate, orders, proofs) and
 * functions/admin.mjs owns the ADMIN /api/admin/* surface (orders, stats,
 * rates, transitions). Everything that touches an order or the rate state
 * lives here so the two surfaces can never disagree about quoting, redaction
 * or persistence.
 *
 * Sections that were admin-only before the split (the transitions, stats,
 * rates apply) deliberately carry NO auth check - the calling function is
 * responsible for requireAdmin() before calling them. That keeps the module a
 * pure data layer and lets the public export reuse the same writes.
 *
 * Blobs note: new keys are readable immediately, updates/deletes propagate
 * within ~60 s, and strong consistency is unavailable on the v1 runtime. The
 * app stays append-only for anything read by prefix listing (orders, rate
 * history, audit) and transitions re-read once after a short delay before
 * reporting a state conflict. See exchange-lib/store.mjs for the full notes.
 */

import { randomBytes, createHash } from 'node:crypto';

import { readJson } from './store.mjs';
import { httpError } from './http.mjs';
import {
  parseRateInput,
  ORDER_STATUSES,
  isFiniteNumber,
} from './validate.mjs';

export const MINIMUMS = { THB: 100, MMK: 10000 };
export const DEFAULT_RATE = 128.5;

const DEFAULT_CHANNELS = [
  { id: 'KBZPay', name: 'KBZPay' },
  { id: 'WavePay', name: 'WavePay' },
  { id: 'PromptPay', name: 'PromptPay' },
  { id: 'KBank', name: 'KBank' },
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeOrderId() {
  return `ord-${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export function makeReference() {
  const time = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return `SC-${time}${rand}`;
}

export function makeViewToken() {
  return randomBytes(24).toString('hex');
}

export function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function quote(amount, direction, thbToMmk) {
  if (direction === 'THB_TO_MMK') {
    return {
      receiveAmount: Math.round(amount * thbToMmk),
      rateUsed: round4(thbToMmk),
      fee: 0,
    };
  }
  return {
    receiveAmount: Math.round((amount / thbToMmk) * 100) / 100,
    rateUsed: round4(1 / thbToMmk),
    fee: 0,
  };
}

function auditKey() {
  return `audit:${Date.now()}:${randomBytes(4).toString('hex')}`;
}

/* Append-only audit write. Entries live under audit:<ts>:<rand> and listing
 * the prefix IS the index. Never maintain a read-modify-write index here -
 * Blobs is eventually consistent and concurrent writes would lose entries.
 * admin.mjs and exchange.mjs both funnel through this so the whole site lands
 * in one log. */
export async function auditEntry(auditStore, action, detail, actor) {
  const entry = { action, detail, createdAt: new Date().toISOString() };
  if (actor) entry.actor = actor;
  await auditStore.set(auditKey(), entry);
}

/* Everything below is stateful only because it closes over the same blob
 * stores; there is no server or handler logic in here. */
export function createOrderStore({ store, proofs: _proofs, auditStore, env = {} }) {
  const log = auditStore || store;
  const getEnv = (name) => {
    const override = env[name];
    return override !== undefined ? override : process.env[name];
  };

  function audit(action, detail, actor) {
    return auditEntry(log, action, detail, actor);
  }

  async function getRate() {
    let current = await readJson(store, 'rate:current');
    if (!current || !isFiniteNumber(current.thbToMmk) || current.thbToMmk <= 0) {
      // The admin Settings screen can record a default seed rate; the env
      // variable and the built-in constant are the fallbacks in that order.
      const configured = await readJson(store, 'setting:defaultRate');
      const seed =
        isFiniteNumber(configured) && configured > 0
          ? configured
          : Number(getEnv('EXCHANGE_RATE_DEFAULT')) || DEFAULT_RATE;
      current = {
        thbToMmk: seed,
        mmkToThb: round4(1 / seed),
        updatedAt: new Date().toISOString(),
        source: 'seed',
      };
      await store.set('rate:current', current);
      await store.set('rate:history:seed', {
        thbToMmk: seed,
        updatedAt: current.updatedAt,
        source: 'seed',
        actor: 'system',
      });
    }
    return {
      ...current,
      mmkToThb: isFiniteNumber(current.mmkToThb)
        ? current.mmkToThb
        : round4(1 / current.thbToMmk),
    };
  }

  async function getOpen() {
    const setting = await readJson(store, 'setting:open');
    return setting === null ? true : setting.open !== false;
  }

  async function getChannels() {
    const channels = await readJson(store, 'setting:channels');
    return channels || DEFAULT_CHANNELS;
  }

  function publicOrder(order) {
    return {
      id: order.id,
      reference: order.reference,
      status: order.status,
      direction: order.direction,
      amount: order.amount,
      receiveAmount: order.receiveAmount,
      rateUsed: order.rateUsed,
      method: order.method,
      level: order.level,
      fee: order.fee,
      hasProof: Boolean(order.proofAt),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      completedAt: order.completedAt || null,
      isRedacted: true,
    };
  }

  function fullOrder(order) {
    return {
      ...publicOrder(order),
      isRedacted: false,
      senderName: order.senderName,
      senderContact: order.senderContact,
      accountNo: order.accountNo || '',
      accountName: order.accountName || '',
      note: order.note || '',
      proofFileName: order.proofFileName || null,
    };
  }

  async function viewOrder(order, token) {
    if (!order) return null;
    const match = token && order.viewToken && token === order.viewToken;
    return match ? fullOrder(order) : publicOrder(order);
  }

  async function readOrder(id) {
    return readJson(store, `order:${id}`);
  }

  async function writeOrder(order) {
    await store.set(`order:${order.id}`, order);
  }

  async function removeOrder(id) {
    // Listing is prefix-based (order: keys), so a delete is just a delete - no
    // index to keep in sync. A briefly-stale list read may still show the order
    // until the delete propagates; that settles within the Blobs window.
    await store.delete(`order:${id}`);
  }

  async function orderIds() {
    return (await store.list({ prefix: 'order:' }))
      .map((entry) => entry.key)
      .filter((key) => key !== 'order:index') // legacy sentinel, never an order
      .map((key) => key.slice('order:'.length));
  }

  async function adminOrdersPage({ status, q, page, perPage }) {
    const wanted = Math.max(1, Math.min(50, perPage || 25));
    const offset = Math.max(0, (page || 1) - 1) * wanted;

    const matched = [];
    for (const id of await orderIds()) {
      const order = await readOrder(id);
      if (!order) continue;
      if (status && order.status !== status) continue;
      if (q) {
        const needle = q.toLowerCase();
        const hay = `${order.reference} ${order.senderName || ''} ${order.method}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      matched.push(order);
    }
    matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    // Authenticated admin listing carries the full order so the panel can show
    // who sent it, the destination account and the note. The storefront list
    // stays redacted via publicOrder in listOrders; this function is admin-only.
    const rows = matched.slice(offset, offset + wanted).map(fullOrder);
    return { orders: rows, total: matched.length, page: offset / wanted + 1, perPage: wanted };
  }

  async function adminStats() {
    const ids = await orderIds();
    const counts = { PENDING: 0, APPROVED: 0, COMPLETED: 0, REJECTED: 0 };
    let volume = 0;
    let pendingVolume = 0;
    for (const id of ids) {
      const order = await readOrder(id);
      if (!order) continue;
      counts[order.status] = (counts[order.status] || 0) + 1;
      if (isFiniteNumber(order.receiveAmount)) {
        volume += order.receiveAmount;
        if (order.status === 'PENDING') pendingVolume += order.receiveAmount;
      }
    }
    return {
      total: ids.length,
      counts,
      volume,
      pendingVolume,
      currency: 'MMK',
    };
  }

  /* Apply an admin transition. Blobs is eventually consistent, so a state just
   * written can briefly read back as its previous value; on a state conflict
   * the order is re-read once after a short delay before giving up. */
  async function transition(id, action, actor) {
    if (action === 'delete') {
      const existing = await readOrder(id);
      if (!existing) throw httpError(404, 'Order not found');
      await removeOrder(id);
      await audit('order.deleted', { id, fromStatus: existing.status }, actor);
      return { ok: true, deleted: true };
    }

    for (let attempt = 0; ; attempt++) {
      const order = await readOrder(id);
      if (!order) throw httpError(404, 'Order not found');

      const fromStatus = order.status;
      let toStatus = fromStatus;
      if (action === 'approve' && fromStatus === 'PENDING') toStatus = 'APPROVED';
      else if (action === 'complete' && fromStatus === 'APPROVED') toStatus = 'COMPLETED';
      else if (action === 'reject' && (fromStatus === 'PENDING' || fromStatus === 'APPROVED')) toStatus = 'REJECTED';
      else {
        if (attempt === 0) {
          await sleep(250);
          continue;
        }
        throw httpError(400, `Cannot ${action} an order in state ${fromStatus}`);
      }

      order.status = toStatus;
      if (toStatus === 'COMPLETED') order.completedAt = new Date().toISOString();
      order.updatedAt = new Date().toISOString();
      await writeOrder(order);
      await audit(`order.${action}`, { id, fromStatus, toStatus }, actor);
      return publicOrder(order);
    }
  }

  async function ratesGet() {
    const rate = await getRate();
    // New-key writes (rate:history:*) are readable immediately; listing the
    // prefix avoids the read-modify-write index that dropped entries live.
    const keys = (await store.list({ prefix: 'rate:history:' }))
      .map((entry) => entry.key)
      .filter((key) => key !== 'rate:history:index') // legacy sentinel
      .sort()
      .reverse();
    const items = [];
    for (const key of keys.slice(0, 20)) {
      const entry = await readJson(store, key);
      if (entry) items.push(entry);
    }
    return { ...rate, open: await getOpen(), history: items };
  }

  /* Apply a rate/open update. Returns the echoed result; optional actor becomes
   * the audit attribution. */
  async function ratesApply(body, actor) {
    if (body.open !== undefined && typeof body.open !== 'boolean') {
      throw httpError(400, 'open must be a boolean');
    }
    const hasRate = body.thbToMmk !== undefined;
    if (!hasRate && body.open === undefined) {
      throw httpError(400, 'Provide thbToMmk and/or open');
    }

    const result = {};
    if (hasRate) {
      let input;
      try {
        input = parseRateInput(body);
      } catch (err) {
        throw httpError(400, err.message);
      }
      const now = new Date().toISOString();
      const next = {
        thbToMmk: input.thbToMmk,
        mmkToThb: round4(1 / input.thbToMmk),
        updatedAt: now,
        source: 'admin',
      };
      await store.set('rate:current', next);
      // Append-only history: new key, listed by prefix when read back.
      await store.set(`rate:history:${Date.now()}:${randomBytes(3).toString('hex')}`, {
        ...next,
        actor: 'admin',
      });
      await audit('rate.updated', { thbToMmk: next.thbToMmk }, actor);
      result.thbToMmk = next.thbToMmk;
      result.mmkToThb = next.mmkToThb;
    }

    if (body.open !== undefined) {
      await store.set('setting:open', { open: body.open });
      await audit('exchange.state', { open: body.open }, actor);
      result.open = body.open;
    }

    return { ok: true, ...result };
  }

  async function auditPage(storeToRead, page = 1) {
    const perPage = 25;
    const list = await storeToRead.list({ prefix: 'audit:' });
    const keys = list
      .map((item) => item.key)
      .filter((key) => key !== 'audit:index')
      .sort()
      .reverse();
    const rows = [];
    for (const key of keys.slice((page - 1) * perPage, page * perPage)) {
      const entry = await readJson(storeToRead, key);
      if (entry) rows.push({ key: key.split(':').slice(1).join(':'), ...entry });
    }
    return { rows, page, perPage, totalKeys: keys.length };
  }

  return {
    audit,
    auditPage,
    getRate,
    getOpen,
    getChannels,
    publicOrder,
    fullOrder,
    viewOrder,
    readOrder,
    writeOrder,
    removeOrder,
    orderIds,
    adminOrdersPage,
    adminStats,
    transition,
    ratesGet,
    ratesApply,
  };
}

/* Not a route - exported for tests that assert the redaction contract without
 * a network round trip. */
export const _internals = {
  hashOf: (v) => createHash('sha256').update(String(v)).digest('hex'),
  ORDER_STATUSES,
};