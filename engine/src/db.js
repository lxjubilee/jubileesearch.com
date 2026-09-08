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
const usePglite = process.env.USE_PGLITE === '1' && process.env.NODE_ENV !== 'production';

export const pool = usePglite ? await (async () => {
  const { createPglitePool } = await import('./db-pglite.js');
  const adapter = await createPglitePool({ dataDir: process.env.PGLITE_DIR ?? null });
  console.warn(JSON.stringify({
    level: 'warn', at: 'db',
    msg: `USE_PGLITE is on. Running against PGlite${process.env.PGLITE_DIR ? ` in ${process.env.PGLITE_DIR}` : ' in memory'}, not a Postgres server. Development only.`,
  }));
  return adapter;
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
