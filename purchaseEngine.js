// purchaseEngine.js
// The one place that knows how to reserve wallet funds and settle a
// transaction. Both the live "Confirm & Pay" request handler and the
// background reconciliation job call these same functions — that's
// deliberate: a pending transaction should resolve exactly the same way
// whether it's confirmed instantly or an hour later.

const crypto = require("node:crypto");
const { db } = require("./db");
const { verifySecret } = require("./auth");

async function verifyPin(userId, pin) {
  const user = await db.get("SELECT pin_hash FROM users WHERE id = ?", [userId]);
  return user && verifySecret(String(pin), user.pin_hash);
}

// Returns { ok: true, txId } or { ok: false, statusCode, error } or
// { ok: false, duplicate: <existing transaction row> }
// planId/providerCostKobo are an optional SNAPSHOT for data purchases —
// see the comment on the transactions table in db.js for why these are
// captured at purchase time rather than joined live against data_plans.
async function reserveFunds({
  userId,
  amountKobo,
  type,
  network,
  phone,
  planLabel,
  planId,
  providerCostKobo,
  idempotencyKey,
}) {
  return db.transaction(async (tx) => {
    if (idempotencyKey) {
      const dupe = await tx.get("SELECT * FROM transactions WHERE idempotency_key = ?", [idempotencyKey]);
      if (dupe) {
        return { ok: false, statusCode: 200, duplicate: dupe };
      }
    }

    const wallet = await tx.get("SELECT balance_kobo FROM wallets WHERE user_id = ?", [userId]);
    if (wallet.balance_kobo < amountKobo) {
      return { ok: false, statusCode: 402, error: "Insufficient wallet balance" };
    }

    const now = new Date().toISOString();
    await tx.run(
      "UPDATE wallets SET balance_kobo = balance_kobo - ?, updated_at = ? WHERE user_id = ?",
      [amountKobo, now, userId]
    );

    const txId = crypto.randomUUID();
    await tx.run(
      `INSERT INTO transactions
         (id, user_id, type, network, phone, plan_label, plan_id, provider_cost_kobo, amount_kobo, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        txId,
        userId,
        type,
        network,
        phone,
        planLabel || null,
        planId || null,
        providerCostKobo ?? null,
        amountKobo,
        idempotencyKey || null,
        now,
        now,
      ]
    );

    return { ok: true, txId };
  });
}

// providerResult: { status: 'success'|'failed'|'pending', providerRef, reason }
async function settleTransaction(txId, providerResult, amountKobo, userId) {
  const now = new Date().toISOString();

  if (providerResult.status === "success") {
    await db.run(
      "UPDATE transactions SET status = 'success', provider_ref = ?, updated_at = ? WHERE id = ?",
      [providerResult.providerRef, now, txId]
    );
  } else if (providerResult.status === "failed") {
    await db.transaction(async (tx) => {
      await tx.run(
        "UPDATE wallets SET balance_kobo = balance_kobo + ?, updated_at = ? WHERE user_id = ?",
        [amountKobo, now, userId]
      );
      await tx.run(
        "UPDATE transactions SET status = 'failed', failure_reason = ?, provider_ref = ?, updated_at = ? WHERE id = ?",
        [providerResult.reason, providerResult.providerRef, now, txId]
      );
    });
  } else {
    // still pending — leave funds reserved, just record that we checked
    // and bump the attempt counter so reconciliation doesn't retry forever
    await db.run(
      `UPDATE transactions
       SET provider_ref = COALESCE(?, provider_ref),
           reconcile_attempts = reconcile_attempts + 1,
           updated_at = ?
       WHERE id = ?`,
      [providerResult.providerRef || null, now, txId]
    );
  }
}

module.exports = { verifyPin, reserveFunds, settleTransaction };
