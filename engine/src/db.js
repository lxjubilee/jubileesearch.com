// The one connection pool. P3, "Postgres first": this is the only data store
// the engine talks to. There is no Redis and no separate vector store.
import pg from 'pg';

// pgvector returns halfvec as a string like '[0.1,0.2]'. Nothing in the query
// path reads an embedding back out -- vectors go in, distances come out -- so
// no custom type parser is registered. If one is ever needed, register it here
// rather than parsing at the call site.

// Development escape hatch: run against PGlite (Postgres compiled to WASM) when
// there is no server to connect to. See src/db-pglite.js for what it is not.
// Two independent conditions, and inert in production whatever the env file says.
const pgliteRequested = process.env.USE_PGLITE === '1';
const isProduction = process.env.NODE_ENV === 'production';
const usePglite = pgliteRequested && !isProduction;

// SAY WHICH DATABASE, AND WHY, ON EVERY START.
//
// This used to announce PGlite when it was chosen and say nothing at all
// otherwise -- so "the engine refuses to fall back to PGlite in production" was
// confirmed by the ABSENCE of a log line. That is the pattern that has now been
// caught four times in this build: a fixture that tested nothing because it never
// reached the code path, an eval preflight that passed against a toy input, a
// startup banner that named the wrong model, and a threshold whose migration and
// database disagreed. Every one of them looked correct by producing no evidence
// of being wrong.
//
// So the decision is stated positively, every time, including the boring case.
const target = usePglite
  ? `PGlite ${process.env.PGLITE_DIR ? `in ${process.env.PGLITE_DIR}` : 'in memory'}`
  : `Postgres ${process.env.PGUSER ?? 'jubileesearch'}@${process.env.PGHOST ?? 'localhost'}:`
    + `${process.env.PGPORT ?? 5432}/${process.env.PGDATABASE ?? 'jubileesearch'}`;

const reason = usePglite
  ? 'USE_PGLITE=1 and NODE_ENV is not production'
  : pgliteRequested
    ? 'USE_PGLITE=1 was IGNORED because NODE_ENV=production'
    : 'USE_PGLITE is not set';

console.log(JSON.stringify({
  level: pgliteRequested && isProduction ? 'warn' : usePglite ? 'warn' : 'info',
  at: 'db.connect',
  database: target,
  reason,
  ...(usePglite ? {
    msg: 'PGlite is a DEVELOPMENT store: single connection, no concurrency, '
      + 'FOR UPDATE SKIP LOCKED does not skip, and nothing operational. See src/db-pglite.js.',
  } : {}),
  ...(pgliteRequested && isProduction ? {
    msg: 'An env file asked for PGlite in production. It was refused and the '
      + 'Postgres settings above were used instead. Fix the env file: a request '
      + 'that is silently overridden is a request someone still believes was honoured.',
  } : {}),
}));

export const pool = usePglite ? await (async () => {
  const { createPglitePool } = await import('./db-pglite.js');
  return createPglitePool({ dataDir: process.env.PGLITE_DIR ?? null });
})() : new pg.Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'jubileesearch',
  user: process.env.PGUSER ?? 'jubileesearch',
  password: process.env.PGPASSWORD,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  // §17: p95 500 ms on cache miss. A query that has run for ten seconds is not
  // going to make that budget; kill it rather than hold a connection.
  statement_timeout: Number(process.env.PGSTATEMENT_TIMEOUT_MS ?? 10_000),
});

pool.on('error', (err) => {
  // An idle client erroring out is not fatal -- the pool replaces it -- but it
  // must be visible, because a storm of these is how a failing database first
  // shows up. Structured JSON, per the observability NFR.
  console.error(JSON.stringify({ level: 'error', at: 'pg.pool', msg: err.message }));
});

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
