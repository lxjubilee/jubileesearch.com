#!/usr/bin/env node
// Migration runner. Each file in db/migrations/ runs once, inside a transaction,
// in filename order, and is recorded in schema_migrations.
//
// Files are not idempotent on their own -- 002 does a bare CREATE TABLE, because
// the specification's DDL is the normative contract and rewriting it with
// IF NOT EXISTS everywhere would make it harder to diff against the document.
// The ledger provides the idempotency instead.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');

// The pool from src/db.js, so USE_PGLITE applies to migrations too and the
// schema is created by the same driver that will query it.
const client = pool;

// 001 creates the ledger, so it cannot be looked up before 001 has run.
await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

const { rows } = await client.query('SELECT version FROM schema_migrations');
const applied = new Set(rows.map((r) => r.version));

const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
let ran = 0;

for (const file of files) {
  const version = file.replace(/\.sql$/, '');
  if (applied.has(version)) continue;

  const sql = await readFile(join(dir, file), 'utf8');
  process.stdout.write(`  ${version} ... `);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    await client.query('COMMIT');
    console.log('ok');
    ran++;
  } catch (err) {
    await client.query('ROLLBACK');
    console.log('FAILED');
    console.error(`\n${version} failed and was rolled back:\n${err.message}\n`);
    await client.end();
    process.exit(1);
  }
}

console.log(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`);
await client.end();
