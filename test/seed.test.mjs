/* Behavioural tests for scripts/seed-admin.mjs - the tool that produces the
 * user:primary row for the SCI_ADMIN blob store.
 *
 * It is a dev tool, not part of the deployed site, but the row shape it writes
 * is the exact contract functions/admin.mjs logs in against, so a wrong shape
 * or a plaintext password here would break admin login silently. These guards
 * run the script against a temp dir and check the emitted row.
 *
 * Run: node --test test/*.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'seed-admin.mjs');
const exec = promisify(execFile);

async function runSeed({ password = 'change-me-123', force = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sky-seed-'));
  const out = join(dir, 'user.json');
  const args = ['scripts/seed-admin.mjs', '--password', password, '--out', out];
  if (force) args.push('--force');
  let result;
  try {
    result = await exec(process.execPath, args, { cwd: join(here, '..') });
  } catch (err) {
    throw new Error(`seed script failed: ${err.stdout} ${err.stderr}`);
  }
  const row = JSON.parse(await readFile(out, 'utf8'));
  return { out, dir, row, stdout: result.stdout };
}

test('the seed script writes a login-ready user:primary row', async () => {
  const { row, dir, stdout } = await runSeed({ password: 'hunter2-secret' });

  assert.match(stdout, /netlify blobs:set SCI_ADMIN user:primary/);
  assert.equal(row.id, 'primary');
  assert.equal(row.role, 'ADMIN');
  assert.equal(typeof row.saltHex, 'string');
  assert.match(row.saltHex, /^[0-9a-f]+$/i);
  assert.equal(typeof row.hashHex, 'string');
  assert.notEqual(row.hashHex, 'hunter2-secret', 'the password is hashed, never stored raw');
  assert.equal(row.username, 'admin');
  assert.equal(row.email, 'contact@skycreation.dev');
  assert.equal(row.authVersion, 0, 'a fresh seed starts at authVersion 0');
  assert.equal(row.failedAttempts, undefined, 'lockout fields are no longer seeded');
  assert.equal(row.lockedUntil, undefined);
  assert.ok(row.createdAt && row.updatedAt && row.passwordChangedAt);
  assert.match(stdout, /session:/, 'reseed instructions mention clearing sessions');

  const { verifyStoredHash } = await import('../functions/exchange-lib/auth.mjs');
  assert.equal(
    await verifyStoredHash('hunter2-secret', row.saltHex, row.hashHex),
    true,
    'the hashed password verifies against the row'
  );
  assert.equal(
    await verifyStoredHash('wrong-password', row.saltHex, row.hashHex),
    false,
    'a wrong password does not verify'
  );

  await rm(dir, { recursive: true, force: true });
});

test('the seed script refuses to overwrite an existing out file', async () => {
  const { out, dir, row } = await runSeed({ password: 'hunter2-secret' });

  assert.ok(row.email, 'first run wrote the row');
  await assert.rejects(
    exec(process.execPath, [script, '--password', 'hunter2-secret', '--out', out], {
      cwd: join(here, '..'),
    }),
    (err) => /already exists/i.test(`${err.stdout} ${err.stderr}`)
  );

  let forced;
  try {
    forced = await runSeed({ password: 'hunter2-secret', force: true });
    assert.ok(forced.row.email, '--force overwrites');
  } finally {
    await rm(forced && forced.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('the seed script exits non-zero without a password', async () => {
  await assert.rejects(
    exec(process.execPath, [script], { cwd: join(here, '..') }),
    (err) => /no password/i.test(`${err.stdout} ${err.stderr}`)
  );
});