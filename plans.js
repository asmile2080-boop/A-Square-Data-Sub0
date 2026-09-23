// plans.js
// The data layer for the pricing catalog. Nothing in this file trusts
// input on its own — server.js validates request bodies before calling
// in here. This file's job is: talk to data_plans / plan_price_history,
// and never let provider cost leak into anything customer-facing (that
// filtering happens here, once, so no route handler can forget it).

const crypto = require("node:crypto");
const { db } = require("./db");

// ---------- customer-facing (never includes provider cost) ----------

function toPublicPlan(row) {
  return {
    id: row.id,
    network: row.network,
    label: row.label,
    validity: row.validity,
    price: row.selling_price_kobo / 100, // naira — the only figure a customer ever sees
  };
}

// Active plans only. This is what /api/plans returns, and it's read fresh
// from the database on every call — no caching layer sits in front of it,
// which is what guarantees a customer always sees the current price the
// moment an admin changes it.
async function listActivePlans(network) {
  const rows = network
    ? await db.all(
        "SELECT * FROM data_plans WHERE is_active = 1 AND network = ? ORDER BY selling_price_kobo ASC",
        [network]
      )
    : await db.all("SELECT * FROM data_plans WHERE is_active = 1 ORDER BY network ASC, selling_price_kobo ASC");
  return rows.map(toPublicPlan);
}

// Used by the purchase flow — returns the full row (including provider
// cost) because the purchase flow needs to snapshot it onto the
// transaction. This function is never called from a customer-facing route.
async function getPlanById(id) {
  return db.get("SELECT * FROM data_plans WHERE id = ?", [id]);
}

// ---------- admin-facing (includes provider cost + margin) ----------

function toAdminPlan(row) {
  return {
    id: row.id,
    network: row.network,
    label: row.label,
    validity: row.validity,
    provider_cost: row.provider_cost_kobo / 100,
    selling_price: row.selling_price_kobo / 100,
    margin: (row.selling_price_kobo - row.provider_cost_kobo) / 100,
    variation_code: row.variation_code,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listAllPlans() {
  const rows = await db.all("SELECT * FROM data_plans ORDER BY network ASC, selling_price_kobo ASC");
  return rows.map(toAdminPlan);
}

async function createPlan(input, adminUserId) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const providerCostKobo = Math.round(input.providerCostNaira * 100);
  const sellingPriceKobo = Math.round(input.sellingPriceNaira * 100);

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO data_plans
         (id, network, label, validity, provider_cost_kobo, selling_price_kobo, variation_code, is_active, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.network,
        input.label,
        input.validity,
        providerCostKobo,
        sellingPriceKobo,
        input.variationCode || null,
        input.isActive === false ? 0 : 1,
        now,
        now,
        adminUserId,
        adminUserId,
      ]
    );
    // Log the initial price too — "old" is null, so the history table's
    // first entry for any plan always shows what it launched at.
    await tx.run(
      `INSERT INTO plan_price_history
         (id, plan_id, old_provider_cost_kobo, new_provider_cost_kobo, old_selling_price_kobo, new_selling_price_kobo, changed_by, changed_at)
       VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`,
      [crypto.randomUUID(), id, providerCostKobo, sellingPriceKobo, adminUserId, now]
    );
  });

  return getPlanById(id).then(toAdminPlan);
}

// updates: any subset of { network, label, validity, providerCostNaira,
// sellingPriceNaira, variationCode }. Only logs to plan_price_history if
// either price field actually changed.
async function updatePlan(id, updates, adminUserId) {
  return db.transaction(async (tx) => {
    const existing = await tx.get("SELECT * FROM data_plans WHERE id = ?", [id]);
    if (!existing) return null;

    const now = new Date().toISOString();
    const next = {
      network: updates.network ?? existing.network,
      label: updates.label ?? existing.label,
      validity: updates.validity ?? existing.validity,
      provider_cost_kobo:
        updates.providerCostNaira !== undefined
          ? Math.round(updates.providerCostNaira * 100)
          : existing.provider_cost_kobo,
      selling_price_kobo:
        updates.sellingPriceNaira !== undefined
          ? Math.round(updates.sellingPriceNaira * 100)
          : existing.selling_price_kobo,
      variation_code: updates.variationCode !== undefined ? updates.variationCode : existing.variation_code,
    };

    const priceChanged =
      next.provider_cost_kobo !== existing.provider_cost_kobo ||
      next.selling_price_kobo !== existing.selling_price_kobo;

    await tx.run(
      `UPDATE data_plans
       SET network = ?, label = ?, validity = ?, provider_cost_kobo = ?, selling_price_kobo = ?,
           variation_code = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
      [
        next.network,
        next.label,
        next.validity,
        next.provider_cost_kobo,
        next.selling_price_kobo,
        next.variation_code,
        now,
        adminUserId,
        id,
      ]
    );

    if (priceChanged) {
      await tx.run(
        `INSERT INTO plan_price_history
           (id, plan_id, old_provider_cost_kobo, new_provider_cost_kobo, old_selling_price_kobo, new_selling_price_kobo, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          existing.provider_cost_kobo,
          next.provider_cost_kobo,
          existing.selling_price_kobo,
          next.selling_price_kobo,
          adminUserId,
          now,
        ]
      );
    }

    const updated = await tx.get("SELECT * FROM data_plans WHERE id = ?", [id]);
    return toAdminPlan(updated);
  });
}

async function setPlanActive(id, isActive, adminUserId) {
  const now = new Date().toISOString();
  const result = await db.run(
    "UPDATE data_plans SET is_active = ?, updated_at = ?, updated_by = ? WHERE id = ?",
    [isActive ? 1 : 0, now, adminUserId, id]
  );
  if (result.changes === 0) return null;
  return getPlanById(id).then(toAdminPlan);
}

async function getPlanPriceHistory(planId) {
  const rows = await db.all(
    "SELECT * FROM plan_price_history WHERE plan_id = ? ORDER BY changed_at DESC",
    [planId]
  );
  return rows.map((r) => ({
    id: r.id,
    old_provider_cost: r.old_provider_cost_kobo === null ? null : r.old_provider_cost_kobo / 100,
    new_provider_cost: r.new_provider_cost_kobo / 100,
    old_selling_price: r.old_selling_price_kobo === null ? null : r.old_selling_price_kobo / 100,
    new_selling_price: r.new_selling_price_kobo / 100,
    changed_by: r.changed_by,
    changed_at: r.changed_at,
  }));
}

// Seeds a starter catalog ONLY if the table is completely empty — so a
// fresh install isn't a blank screen, but this never overwrites or
// resets anything an admin has already configured. Illustrative starting
// prices/costs only; edit or delete them via the admin API once you have
// real provider costs.
async function seedDefaultPlansIfEmpty() {
  const countRow = await db.get("SELECT COUNT(*) as count FROM data_plans");
  // Postgres returns COUNT(*) as a string (bigint); SQLite returns a number.
  // Number() normalizes either.
  if (Number(countRow.count) > 0) return;

  const templates = [
    { label: "1GB", validity: "1 day", sellingPriceNaira: 350 },
    { label: "2GB", validity: "7 days", sellingPriceNaira: 800 },
    { label: "5GB", validity: "30 days", sellingPriceNaira: 1800 },
    { label: "10GB", validity: "30 days", sellingPriceNaira: 3200 },
    { label: "15GB", validity: "30 days", sellingPriceNaira: 4500 },
    { label: "40GB", validity: "30 days", sellingPriceNaira: 9500 },
  ];
  const networks = ["mtn", "airtel", "glo", "9mobile"];

  // adminUserId is null here on purpose — this runs at boot, before any
  // admin necessarily exists yet. created_by/updated_by allow NULL for
  // exactly this reason ("seeded by the system, not a person").
  for (const network of networks) {
    for (const t of templates) {
      await createPlan(
        {
          network,
          label: t.label,
          validity: t.validity,
          // Illustrative ~15% margin — replace with your real VTU cost
          // per network/plan via the admin API once you have one.
          providerCostNaira: Math.round(t.sellingPriceNaira * 0.85),
          sellingPriceNaira: t.sellingPriceNaira,
        },
        null
      );
    }
  }
  console.log(`[plans] Seeded ${networks.length * templates.length} starter data plans (edit via /api/admin/plans)`);
}

module.exports = {
  listActivePlans,
  getPlanById,
  listAllPlans,
  createPlan,
  updatePlan,
  setPlanActive,
  getPlanPriceHistory,
  seedDefaultPlansIfEmpty,
};
