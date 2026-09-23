// providers/vtuProvider.js
//
// Same pattern as paymentProvider.js: server.js only ever calls
// vtuProvider.deliverAirtime / deliverData / checkStatus — never VTpass's
// API directly — so switching providers never touches server.js.
//
//   VTU_PROVIDER=mock     (default — no setup needed)
//   VTU_PROVIDER=vtpass   (real, needs VTU_API_KEY, VTU_SECRET_KEY, VTU_PUBLIC_KEY)

const crypto = require("node:crypto");

// ---------- MOCK (default) ----------

function simulateNetworkDelay() {
  return new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 500));
}

// Deliberately controllable outcomes so you (and this chat) can test every
// state without waiting on luck:
//   phone ending in "0" -> always fails      (simulate a bad number / network reject)
//   phone ending in "1" -> always pending    (simulate a slow provider)
//   anything else       -> succeeds ~92% of the time
function decideOutcome(phone) {
  if (phone.endsWith("0")) return "failed";
  if (phone.endsWith("1")) return "pending";
  return Math.random() < 0.92 ? "success" : "failed";
}

const mockVtuProvider = {
  name: "mock",

  async deliverAirtime({ network, phone, amountKobo }) {
    await simulateNetworkDelay();
    const outcome = decideOutcome(phone);
    return {
      status: outcome,
      providerRef: "VTU-" + crypto.randomBytes(6).toString("hex"),
      reason:
        outcome === "failed"
          ? "Network provider rejected the recharge (simulated)"
          : outcome === "pending"
          ? "Provider has not confirmed delivery yet (simulated)"
          : null,
    };
  },

  async deliverData({ network, phone, planLabel, amountKobo }) {
    await simulateNetworkDelay();
    const outcome = decideOutcome(phone);
    return {
      status: outcome,
      providerRef: "VTU-" + crypto.randomBytes(6).toString("hex"),
      reason:
        outcome === "failed"
          ? "Data plan unavailable on this network (simulated)"
          : outcome === "pending"
          ? "Provider has not confirmed delivery yet (simulated)"
          : null,
    };
  },

  async checkStatus({ providerRef }) {
    await simulateNetworkDelay();
    const roll = Math.random();
    if (roll < 0.6) return { status: "success", providerRef };
    if (roll < 0.75) return { status: "failed", providerRef, reason: "Provider confirmed the recharge did not go through" };
    return { status: "pending", providerRef };
  },
};

// ---------- REAL VTPASS ----------
//
// Matches VTpass's documented REST API as of this writing. Before going
// live: (1) VTpass has a free sandbox ("demo") environment with its own
// demo API keys and a demo base URL — use that first, never real keys
// during development, (2) double-check field names against
// https://vtpass.com/documentation/ in case anything's changed, (3)
// VTpass expects a unique request_id per attempt — we build one from the
// transaction id, which is already unique.

const VTPASS_BASE = process.env.VTU_BASE_URL || "https://vtpass.com/api";

// VTpass service IDs for airtime differ by network; data bundles use a
// separate "variation_code" per plan. You'll need to map DATA_PLANS (in
// server.js) to VTpass's actual variation codes from their /api/service-variations
// endpoint — the values below are illustrative placeholders.
const NETWORK_TO_AIRTIME_SERVICE = {
  mtn: "mtn",
  airtel: "airtel",
  glo: "glo",
  "9mobile": "etisalat", // VTpass still uses the old "etisalat" service ID for 9mobile
};

function vtpassHeaders() {
  const apiKey = process.env.VTU_API_KEY;
  const secretKey = process.env.VTU_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error(
      "VTU_API_KEY / VTU_SECRET_KEY are not set. Register for a VTpass sandbox account, " +
      "grab your demo keys, and set them as environment variables before using VTU_PROVIDER=vtpass."
    );
  }
  return { "api-key": apiKey, "secret-key": secretKey, "Content-Type": "application/json" };
}

async function vtpassPay({ serviceID, phone, amountNaira, variationCode, requestId }) {
  const body = { request_id: requestId, serviceID, phone, billersCode: phone };
  if (variationCode) {
    body.variation_code = variationCode; // data bundles
  } else {
    body.amount = amountNaira; // airtime — variable amount, no variation code
  }
  const res = await fetch(`${VTPASS_BASE}/pay`, {
    method: "POST",
    headers: vtpassHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // VTpass response codes: "000" success, "099" pending/processing (still
  // being confirmed), anything else is a failure. See their docs for the
  // full code table — this covers the three states our app needs.
  const code = data.code;
  const status = code === "000" ? "success" : code === "099" ? "pending" : "failed";
  return {
    status,
    providerRef: requestId,
    reason: status === "failed" ? data.response_description || "VTpass declined the request" : null,
  };
}

const realVtpassProvider = {
  name: "vtpass",

  async deliverAirtime({ network, phone, amountKobo }) {
    const serviceID = NETWORK_TO_AIRTIME_SERVICE[network];
    const amountNaira = amountKobo / 100;
    const requestId = "asquare-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
    return vtpassPay({ serviceID, phone, amountNaira, requestId });
  },

  async deliverData({ network, phone, planLabel, amountKobo, variationCode }) {
    const serviceID = network + "data"; // VTpass convention, e.g. "mtn-data" — verify exact ID per network
    const requestId = "asquare-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
    // NOTE: variationCode comes from the matching row in the data_plans
    // table (set via the admin API) — map each plan to VTpass's real
    // variation code there once you have their catalog.
    return vtpassPay({ serviceID, phone, variationCode, requestId });
  },

  async checkStatus({ providerRef }) {
    const res = await fetch(`${VTPASS_BASE}/requery`, {
      method: "POST",
      headers: vtpassHeaders(),
      body: JSON.stringify({ request_id: providerRef }),
    });
    const data = await res.json();
    const code = data.code;
    const status = code === "000" ? "success" : code === "099" ? "pending" : "failed";
    return { status, providerRef, reason: status === "failed" ? data.response_description : null };
  },
};

// ---------- export whichever one is configured ----------
const providers = { mock: mockVtuProvider, vtpass: realVtpassProvider };
const selected = process.env.VTU_PROVIDER || "mock";
if (!providers[selected]) {
  throw new Error(`Unknown VTU_PROVIDER "${selected}". Valid options: ${Object.keys(providers).join(", ")}`);
}

module.exports = providers[selected];
