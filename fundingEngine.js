// fundingEngine.js
//
// Wallet-funding can be confirmed two ways: the frontend calling
// /api/wallet/fund/verify right after checkout, or Paystack's webhook
// calling /api/webhooks/paystack some time later. Both roads lead here,
// so a payment settles exactly once no matter which one gets there first —
// the atomic "is it still pending?" check inside the transaction is what
// makes that safe even if both arrive at nearly the same instant.

const { db } = require("./db");

// result: { status: 'success' | 'failed', reason? }
// Returns { ok:true, alreadyProcessed:false, status } on a fresh settle,
// { ok:true, alreadyProcessed:true, status } if something already settled
// it, or { ok:false, error } if the transaction id doesn't exist at all.
async function settleFunding(txId, result, amountKobo, userId) {
  return db.transaction(async (tx) => {
    const existing = await tx.get("SELECT status FROM transactions WHERE id = ?", [txId]);
    if (!existing) {
      return { ok: false, error: "Transaction not found" };
    }
    if (existing.status !== "pending") {
      // Already settled by the other path — nothing to do, and importantly
      // we must NOT credit the wallet a second time.
      return { ok: true, alreadyProcessed: true, status: existing.status };
    }

    const now = new Date().toISOString();

    if (result.status === "success") {
      await tx.run(
        "UPDATE wallets SET balance_kobo = balance_kobo + ?, updated_at = ? WHERE user_id = ?",
        [amountKobo, now, userId]
      );
      await tx.run("UPDATE transactions SET status = 'success', updated_at = ? WHERE id = ?", [now, txId]);
    } else {
      await tx.run(
        "UPDATE transactions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?",
        [result.reason || "Payment failed", now, txId]
      );
    }

    return { ok: true, alreadyProcessed: false, status: result.status };
  });
}

module.exports = { settleFunding };
