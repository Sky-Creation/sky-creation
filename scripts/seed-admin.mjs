/* Seed the site-wide admin account for the admin panel (functions/admin.mjs).
 *
 * The admin function stores one user row in the SCI_ADMIN blob store under
 * `user:primary`; its password is an scrypt hash, never plaintext. This script
 * hashes a password and writes the JSON row to a file, ready for:
 *
 *     netlify blobs:set SCI_ADMIN user:primary --input seed-admin-out.json
 *
 * (see "Treat the blob CLI as a first-class admin tool" in AGENTS.md). The
 * row may also be seeded locally with SKY_EXCHANGE_TEST=1 for development.
 *
 * Run from the repo root, with node. No site files are touched; nothing here
 * is published. Options:
 *
 *   node scripts/seed-admin.mjs --password <pw> [--email ..] [--username ..]
 *                                [--name ..] [--out <file>] [--force]
 *
 * The password can instead come from $env:EXCHANGE_ADMIN_PASSWORD. The row is
 * only written to the out file - it is not pushed to Netlify by this script.
 */
import { writeFile, access } from 'node:fs/promises';
import { scryptHash } from '../functions/exchange-lib/auth.mjs';
import { EMAIL_RE } from '../functions/exchange-lib/validate.mjs';

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;

function usage() {
  console.error(
    'usage: node scripts/seed-admin.mjs --password <pw> [--email <email>] [--username <user>] [--name <name>] [--out <file>] [--force]'
  );
}

function flag(name, def) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function has(name) {
  return process.argv.indexOf(name) !== -1;
}

async function main() {
  if (has('--help') || has('-h')) {
    usage();
    return;
  }

  const password = flag('--password', process.env.EXCHANGE_ADMIN_PASSWORD || '');
  const email = flag('--email', process.env.CONTACT_TO || 'contact@skycreation.dev').toLowerCase();
  const username = flag('--username', 'admin');
  const name = flag('--name', 'Sky Creation');
  const out = flag('--out', 'seed-admin-out.json');
  const force = has('--force');

  if (!password) {
    console.error('no password: pass --password or set EXCHANGE_ADMIN_PASSWORD');
    usage();
    process.exit(1);
  }
  if (password.length < 8 || password.length > 256) {
    console.error(`password must be 8-256 characters (got ${password.length})`);
    process.exit(1);
  }
  if (!EMAIL_RE.test(email)) {
    console.error(`email is invalid: ${email}`);
    process.exit(1);
  }
  if (!USERNAME_RE.test(username)) {
    console.error(`username must be 3-64 characters of letters, numbers, . _ -`);
    process.exit(1);
  }

  let exists = false;
  try {
    await access(out);
    exists = true;
  } catch (err) {
    exists = false;
  }
  if (exists && !force) {
    console.error(`${out} already exists - pass --force to overwrite`);
    process.exit(1);
  }

  const { saltHex, hashHex } = await scryptHash(password);

  const now = new Date().toISOString();
  const row = {
    id: 'primary',
    role: 'ADMIN',
    username,
    email,
    name,
    saltHex,
    hashHex,
    failedAttempts: 0,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
    passwordChangedAt: now,
  };

  await writeFile(out, JSON.stringify(row, null, 2) + '\n', 'utf8');
  console.log(`wrote ${out}`);
  console.log('');
  console.log('push it to the SCI_ADMIN blob store (company site account):');
  console.log(`  netlify blobs:set SCI_ADMIN user:primary --input ${out}`);
  console.log('');
  console.log(`login with: username ${username} or email ${email}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});