// DEVELOPMENT ONLY. A `pg`-shaped adapter over PGlite.
//
// ---------------------------------------------------------------------------
// Why this exists
//
// The engine needs Postgres 16+ with pgvector 0.7+, and there is no Postgres on
// every machine that needs to run this. PGlite is Postgres compiled to WASM: it
// is the real query planner, the real type system and the real extensions, in
// process, with no server to install. Enough of it is real that the migrations
// and the query pipeline can be *executed* rather than only reviewed, which is
// the difference between "this SQL looks right" and "this SQL runs".
//
// This is not a production path and must not become one. What it is missing:
//
//   * Concurrency. PGlite is a single connection. `connect()` hands back the
//     same one, so two overlapping transactions would interleave rather than
//     isolate. Nothing in the read path opens a transaction, so a dev server
//     serving one person is fine; a load test is not.
//   * `SELECT ... FOR UPDATE SKIP LOCKED` degrades to a plain lock, because
//     there is nothing to skip. The crawl queue and the embedding job work, but
//     they cannot demonstrate that several workers share the queue correctly.
//   * Everything operational: replication, backups, WAL archiving, and the
//     `UNLOGGED` distinction that makes the cache tables cheap.
//
// Enable with USE_PGLITE=1. `src/db.js` refuses it when NODE_ENV=production.
// ---------------------------------------------------------------------------

const EXTENSIONS = ['vector', 'pg_trgm', 'unaccent', 'pgcrypto', 'btree_gin'];

export async function createPglitePool({ dataDir = null } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { unaccent } = await import('@electric-sql/pglite/contrib/unaccent');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const { btree_gin } = await import('@electric-sql/pglite/contrib/btree_gin');

  const db = await PGlite.create({
    dataDir: dataDir ?? undefined,   // undefined = in memory, gone on exit
    extensions: { vector, pg_trgm, unaccent, pgcrypto, btree_gin },
  });

  // Migration 001 does `CREATE EXTENSION IF NOT EXISTS` itself, but it can only
  // succeed for extensions the WASM build was given at startup. Creating them
  // here first means 001 finds them already present and its version check runs
  // against the real installed version.
  for (const name of EXTENSIONS) {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS ${name}`);
  }

  return adapt(db);
}

/**
 * The subset of the `pg` Pool surface this codebase actually uses:
 * query(text, params), connect(), end(), and on().
 */
function adapt(db) {
  const client = {
    query: (text, params) => run(db, text, params),
    release: () => {},
  };

  return {
    _pglite: db,
    query: (text, params) => run(db, text, params),
    connect: async () => client,
    end: () => db.close(),
    on: () => {},
  };
}

async function run(db, text, params) {
  // PGlite splits the two calls that `pg` merges: `query` takes parameters and
  // one statement, `exec` takes many statements and none. A migration file is
  // the second kind.
  const result = params?.length
    ? await db.query(text, params.map(coerce))
    : lastOf(await db.exec(text));

  const rows = result?.rows ?? [];
  return {
    rows,
    // `pg` reports rowCount as the number of rows returned for a SELECT and the
    // number affected otherwise. PGlite reports them separately, so ON CONFLICT
    // DO NOTHING -- which returns nothing and affects a variable number -- would
    // otherwise always read as zero.
    rowCount: rows.length || result?.affectedRows || 0,
    fields: result?.fields ?? [],
  };
}

const lastOf = (results) => (Array.isArray(results) ? results.at(-1) : results);

// PGlite's serialiser wants plain values. Buffers (bytea) and BigInts (the
// SimHash) are the two this codebase passes that it will not take as they are.
function coerce(value) {
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => (Buffer.isBuffer(v) ? new Uint8Array(v) : v));
  return value;
}
