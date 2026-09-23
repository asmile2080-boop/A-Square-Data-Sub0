// db.js
// Picks a database backend and exposes ONE shared interface for the rest
// of the app to use: db.get / db.all / db.run / db.exec / db.transaction.
// Every other file talks to this interface only — never to node:sqlite or
// 'pg' directly — so the backend can be swapped by an environment
// variable, with zero code changes anywhere else.
//
//   No DATABASE_URL set  -> SQLite, a single local file (great for dev)
//   DATABASE_URL set     -> Postgres (what you'd use in production)
//
// The schema below is deliberately written in a dialect both backends
// understand identically (no AUTOINCREMENT, no SQLite-specific functions)
// so this one definition works for both — see the individual adapters in
// ./db-adapters/ for the small differences in how they execute it.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  -- Admin status is set ONLY by server-side sync against the ADMIN_PHONES
  -- environment variable (see server.js's syncAdminStatus) — there is no
  -- API that lets anyone, including an authenticated user, set this
  -- themselves. That's what makes "admin" a deployment-config decision
  -- rather than an in-app privilege an attacker could ever grant themselves.
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  balance_kobo INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- The admin-controlled pricing catalog. provider_cost_kobo (what the VTU
-- provider charges us) and selling_price_kobo (what the customer pays) are
-- deliberately separate columns — the customer-facing API and the
-- customer-facing frontend are never allowed to read provider_cost_kobo.
CREATE TABLE IF NOT EXISTS data_plans (
  id                 TEXT PRIMARY KEY,
  network            TEXT NOT NULL CHECK (network IN ('mtn','airtel','glo','9mobile')),
  label              TEXT NOT NULL,
  validity           TEXT NOT NULL,
  provider_cost_kobo INTEGER NOT NULL,
  selling_price_kobo INTEGER NOT NULL,
  variation_code     TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  created_by         TEXT REFERENCES users(id),
  updated_by         TEXT REFERENCES users(id)
);

-- Every price/cost change to a plan is logged here — who changed it, and
-- what it changed from/to. Nothing deletes old rows; this table only grows.
CREATE TABLE IF NOT EXISTS plan_price_history (
  id                     TEXT PRIMARY KEY,
  plan_id                TEXT NOT NULL REFERENCES data_plans(id),
  old_provider_cost_kobo INTEGER,
  new_provider_cost_kobo INTEGER,
  old_selling_price_kobo INTEGER,
  new_selling_price_kobo INTEGER,
  changed_by             TEXT REFERENCES users(id),
  changed_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  type               TEXT NOT NULL CHECK (type IN ('wallet_funding','airtime','data')),
  network            TEXT,
  phone              TEXT,
  plan_label         TEXT,
  -- plan_id + provider_cost_kobo are a SNAPSHOT of the plan at the moment
  -- of purchase. Deliberately not just a foreign key we join against live —
  -- if the admin changes the price tomorrow, last month's profit reports
  -- must still reflect what was actually charged and actually cost back then.
  plan_id            TEXT REFERENCES data_plans(id),
  provider_cost_kobo INTEGER,
  amount_kobo        INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','success','failed')),
  provider_ref       TEXT,
  idempotency_key    TEXT UNIQUE,
  failure_reason     TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plans_network_active ON data_plans(network, is_active);
CREATE INDEX IF NOT EXISTS idx_price_history_plan ON plan_price_history(plan_id, changed_at DESC);
`;

// Amounts are stored as integer kobo (1 naira = 100 kobo) everywhere —
// never as a float. 0.1 + 0.2 !== 0.3 in floating point, and that's
// exactly how a wallet ends up off by a few kobo after enough transactions.
function nairaToKobo(naira) {
  return Math.round(Number(naira) * 100);
}
function koboToNaira(kobo) {
  return kobo / 100;
}

const backend = process.env.DATABASE_URL
  ? require("./postgres")(SCHEMA)
  : require("./sqlite")(SCHEMA);

module.exports = { db: backend, nairaToKobo, koboToNaira };
