// db-adapters/sqlite.js
// The local-dev backend — zero setup, one file, uses Node's built-in
// node:sqlite (no npm install). node:sqlite's calls are synchronous
// under the hood; this wraps every result in Promise.resolve() so calling
// code can use the exact same `await db.get(...)` style regardless of
// which backend is active.

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

module.exports = function createSqliteDb(schemaSql) {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "asquare.db");
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA journal_mode = WAL;"); // safer for concurrent reads/writes
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(schemaSql);

  function get(sql, params = []) {
    return Promise.resolve(raw.prepare(sql).get(...params));
  }
  function all(sql, params = []) {
    return Promise.resolve(raw.prepare(sql).all(...params));
  }
  function run(sql, params = []) {
    const result = raw.prepare(sql).run(...params);
    return Promise.resolve({ changes: result.changes, lastInsertRowid: result.lastInsertRowid });
  }
  function exec(sql) {
    raw.exec(sql);
    return Promise.resolve();
  }

  // SQLite here is a single local connection, so a "transaction" is just
  // BEGIN IMMEDIATE / COMMIT / ROLLBACK around the same get/all/run — no
  // separate connection needed, unlike Postgres (see postgres.js).
  async function transaction(fn) {
    raw.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn({ get, all, run });
      raw.exec("COMMIT");
      return result;
    } catch (err) {
      raw.exec("ROLLBACK");
      throw err;
    }
  }

  return { get, all, run, exec, transaction, ready: Promise.resolve(), name: "sqlite" };
};
