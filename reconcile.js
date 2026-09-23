// reconcile.js
//
// Handles the one gap left by the purchase flow: a transaction that came
// back "pending" (the VTU provider didn't say success or failure in time).
// Funds are already held for it — this job periodically asks the provider
// "did that go through yet?" via checkStatus(), and settles the
// transaction using the exact same settleTransaction() function the live
// purchase flow uses, so the outcome is handled identically either way.

const { db } = require("./db");
const vtuProvider = require("./providers/vtuProvider");
const { settleTransaction } = require("./purchaseEngine");

// Stop asking forever — after this many failed check-ins, leave it pending
// for a human to look at rather than silently retrying indefinitely.
const MAX_ATTEMPTS = 10;

async function reconcilePendingTransactions() {
  const pending = await db.all(
    `SELECT * FROM transactions
     WHERE status = 'pending' AND type IN ('airtime','data') AND reconcile_attempts < ?
     ORDER BY created_at ASC`,
    [MAX_ATTEMPTS]
  );

  const results = [];
  for (const tx of pending) {
    try {
      const providerResult = await vtuProvider.checkStatus({ providerRef: tx.provider_ref });
      await settleTransaction(tx.id, providerResult, tx.amount_kobo, tx.user_id);
      results.push({ id: tx.id, resolvedTo: providerResult.status });
    } catch (err) {
      // A network error talking to the provider shouldn't crash the whole
      // sweep — log it and move on to the next transaction.
      console.error(`Reconciliation failed for transaction ${tx.id}:`, err.message);
      results.push({ id: tx.id, resolvedTo: "error", error: err.message });
    }
  }

  if (results.length) {
    console.log(`[reconcile] checked ${results.length} pending transaction(s):`, results);
  }
  return results;
}

function startReconciliationLoop(intervalMs) {
  // Run once shortly after boot, then on the interval — no need to wait a
  // full cycle before the first sweep.
  setTimeout(() => reconcilePendingTransactions().catch((e) => console.error("[reconcile]", e)), 5000);
  setInterval(() => reconcilePendingTransactions().catch((e) => console.error("[reconcile]", e)), intervalMs);
}

module.exports = { reconcilePendingTransactions, startReconciliationLoop, reconcileNow: reconcilePendingTransactions };
