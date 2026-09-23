// providers/paymentProvider.js
//
// This file is the ONLY place that should know how to talk to a payment
// gateway. server.js only ever calls paymentProvider.initiatePayment /
// verifyPayment — never Paystack's API directly — so switching providers,
// or switching from mock to real, never touches server.js.
//
// Which one is active is controlled by an environment variable:
//   PAYMENT_PROVIDER=mock      (default — no setup needed)
//   PAYMENT_PROVIDER=paystack  (real, needs PAYSTACK_SECRET_KEY)

const crypto = require("node:crypto");

// ---------- MOCK (default) ----------

// In-memory store of "pending" mock payments, keyed by reference.
// A real gateway would hold this state on their servers, not yours.
const mockPayments = new Map();

const mockPaymentProvider = {
  name: "mock",

  async initiatePayment({ amountKobo, userId }) {
    const reference = "MOCK-" + crypto.randomBytes(8).toString("hex");
    mockPayments.set(reference, { amountKobo, userId, status: "pending" });
    return {
      reference,
      checkoutUrl: `https://mock-checkout.local/pay/${reference}`,
    };
  },

  async verifyPayment({ reference }) {
    const record = mockPayments.get(reference);
    if (!record) {
      return { status: "failed", reason: "Unknown payment reference" };
    }
    const success = Math.random() < 0.9;
    record.status = success ? "success" : "failed";
    mockPayments.set(reference, record);
    return {
      status: record.status,
      amountKobo: record.amountKobo,
      reason: success ? null : "Card declined (simulated)",
    };
  },
};

// ---------- REAL PAYSTACK ----------
//
// Matches Paystack's documented REST API as of this writing. Before going
// live: (1) test against their sandbox with a sk_test_ key first, (2)
// double check the request/response shape against https://paystack.com/docs
// in case anything's changed since, (3) also set up their webhook
// (POST to a /api/webhooks/paystack route you'd add) rather than relying
// solely on the frontend calling /api/wallet/fund/verify — a webhook still
// arrives even if the user closes the app mid-payment.

const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not set. Get a test key from your Paystack dashboard " +
      "(Settings > API Keys & Webhooks) and set it as an environment variable before " +
      "using PAYMENT_PROVIDER=paystack."
    );
  }
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

const realPaystackProvider = {
  name: "paystack",

  async initiatePayment({ amountKobo, email }) {
    if (!email) {
      throw new Error("Paystack requires an email address to initialize a transaction");
    }
    const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: paystackHeaders(),
      // Paystack's "amount" field is already in kobo, matching how we
      // store money internally — no conversion needed here.
      body: JSON.stringify({ email, amount: amountKobo }),
    });
    const data = await res.json();
    if (!res.ok || !data.status) {
      throw new Error(data.message || "Paystack initialize failed");
    }
    return {
      reference: data.data.reference,
      checkoutUrl: data.data.authorization_url,
    };
  },

  async verifyPayment({ reference }) {
    const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: paystackHeaders(),
    });
    const data = await res.json();
    if (!res.ok || !data.status) {
      return { status: "failed", reason: data.message || "Could not verify transaction" };
    }
    const paystackStatus = data.data.status; // 'success' | 'failed' | 'abandoned' | ...
    return {
      status: paystackStatus === "success" ? "success" : "failed",
      amountKobo: data.data.amount,
      reason: paystackStatus === "success" ? null : `Paystack reported status: ${paystackStatus}`,
    };
  },
};

// ---------- export whichever one is configured ----------
const providers = { mock: mockPaymentProvider, paystack: realPaystackProvider };
const selected = process.env.PAYMENT_PROVIDER || "mock";
if (!providers[selected]) {
  throw new Error(`Unknown PAYMENT_PROVIDER "${selected}". Valid options: ${Object.keys(providers).join(", ")}`);
}

module.exports = providers[selected];
