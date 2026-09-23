// db-adapters/postgres.js
// The production backend. Activated automatically when DATABASE_URL is
// set. Needs the 'pg' package — that's a real npm install, done on your
// own machine/server where internet access is available (this project's
// dev sandbox intentionally has none, which is exactly why the default
// backend is dependency-free SQLite):
//
//   npm install pg
//
// This file was written to match 'pg' v8's documented API and hasn't been
// run against a live Postgres server in this environment (no network
// access here) — test it against your own database before relying on it.
// The interface it exposes (get/all/run/exec/transaction) is identical to
// the SQLite adapter's, so every call site in the app already works
// against this without any further changes once you've verified it.

function toPgPlaceholders(sql) {
  // App code writes plain `?` placeholders (SQLite style); Postgres wants
  // `$1, $2, ...`. This converts one to the other so query strings don't
  // need to be written twice.
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

module.exports = function createPostgresDb(schemaSql) {
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch {
    throw new Error(
      "DATABASE_URL is set but the 'pg' package isn't installed. Run: npm install pg"
    );
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Most managed Postgres providers (Render, Railway, RDS, etc.) require
    // SSL and present a certificate that isn't in Node's default trust
    // store. Set DATABASE_SSL=false explicitly for a local/self-hosted
    // Postgres that isn't using SSL at all.
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  async function get(sql, params = [], client = pool) {
    const res = await client.query(toPgPlaceholders(sql), params);
    return res.rows[0];
  }
  async function all(sql, params = [], client = pool) {
    const res = await client.query(toPgPlaceholders(sql), params);
    return res.rows;
  }
  async function run(sql, params = [], client = pool) {
    const res = await client.query(toPgPlaceholders(sql), params);
    return { changes: res.rowCount };
  }
  async function exec(sql, client = pool) {
    await client.query(sql); // DDL / multi-statement — no placeholder conversion needed
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = {
        get: (sql, params) => get(sql, params, client),
        all: (sql, params) => all(sql, params, client),
        run: (sql, params) => run(sql, params, client),
      };
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // Schema creation is async here (unlike SQLite) — server.js awaits
  // `db.ready` before it starts listening, so no request can arrive
  // before the tables exist.
  const ready = exec(schemaSql).catch((err) => {
    console.error("Failed to initialize Postgres schema:", err);
    throw err;
  });

  return { get, all, run, exec, transaction, ready, name: "postgres" };
};
