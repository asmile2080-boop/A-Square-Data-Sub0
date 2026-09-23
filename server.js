// server.js
// A Square Data Sub — backend. Plain Node.js http server (no Express),
// so there is nothing to `npm install` to run this in local/dev mode.
//
// Run:   node server.js
//        DATABASE_URL=postgres://... node server.js   (production DB)

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { db, nairaToKobo, koboToNaira } = require("./db");
const {
  hashSecret,
  verifySecret,
  createSession,
  requireAuth,
  requireAdmin,
  sendJson,
} = require("./auth");
const paymentProvider = require("./paymentProvider");
const vtuProvider = require("./vtuProvider");
const { verifyPin, reserveFunds, settleTransaction } = require("./purchaseEngine");
const { settleFunding } = require("./fundingEngine");
const { startReconciliationLoop, reconcileNow } = require("./reconcile");
const plans = require("./plans");

const VALID_NETWORKS = ["mtn", "airtel", "glo", "9mobile"];

const PORT = process.env.PORT || 4000;

// Raw (unparsed) body reader — needed for the Paystack webhook, where we
// must verify a signature over the exact bytes Paystack sent before we're
// allowed to trust (or even parse) the JSON.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------- tiny body parser (Express does this for you; here we do it by hand) ----------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // guard against absurdly large bodies
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function getUserPublic(user) {
  return {
    id: user.id,
    full_name: user.full_name,
    phone: user.phone,
    email: user.email,
    is_admin: user.is_admin === 1,
  };
}

// Admin status is controlled ENTIRELY by this environment variable — a
// comma-separated list of phone numbers. There is no API endpoint that
// sets is_admin from a request body; the only way in is having access to
// the server's own environment configuration. Called on every
// register/login so a phone number added to (or removed from)
// ADMIN_PHONES takes effect the next time that person logs in, with no
// manual database edit needed.
function getAdminPhones() {
  return (process.env.ADMIN_PHONES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function syncAdminStatus(user) {
  const shouldBeAdmin = getAdminPhones().includes(user.phone) ? 1 : 0;
  if (user.is_admin !== shouldBeAdmin) {
    await db.run("UPDATE users SET is_admin = ? WHERE id = ?", [shouldBeAdmin, user.id]);
    user.is_admin = shouldBeAdmin;
  }
  return user;
}

async function getWallet(userId) {
  return db.get("SELECT balance_kobo FROM wallets WHERE user_id = ?", [userId]);
}

// ---------- route handlers ----------

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  const { full_name, phone, email, password, pin } = body;

  if (!full_name || !phone || !password || !pin) {
    return sendJson(res, 400, {
      error: "full_name, phone, password and pin are all required",
    });
  }
  if (String(password).length < 6) {
    return sendJson(res, 400, { error: "Password must be at least 6 characters" });
  }
  if (!/^\d{4}$/.test(String(pin))) {
    return sendJson(res, 400, { error: "PIN must be exactly 4 digits" });
  }

  const existing = await db.get("SELECT id FROM users WHERE phone = ?", [phone]);
  if (existing) {
    return sendJson(res, 409, { error: "An account with this phone number already exists" });
  }

  const passwordHash = hashSecret(password);
  const pinHash = hashSecret(pin);
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Two related inserts (user + wallet row) — wrap in a transaction so we
  // never end up with a user that has no wallet, even if something fails
  // mid-way.
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO users (id, full_name, phone, email, password_hash, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [userId, full_name, phone, email || null, passwordHash, pinHash, now]
    );
    await tx.run("INSERT INTO wallets (user_id, balance_kobo, updated_at) VALUES (?, 0, ?)", [userId, now]);
  });

  const token = await createSession(userId);
  const user = await syncAdminStatus(await db.get("SELECT * FROM users WHERE id = ?", [userId]));
  sendJson(res, 201, { token, user: getUserPublic(user), wallet_balance: 0 });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const { phone, password } = body;
  if (!phone || !password) {
    return sendJson(res, 400, { error: "phone and password are required" });
  }

  let user = await db.get("SELECT * FROM users WHERE phone = ?", [phone]);
  // Same error for "no such user" and "wrong password" — don't reveal
  // which one it was, that helps attackers enumerate real phone numbers.
  if (!user || !verifySecret(password, user.password_hash)) {
    return sendJson(res, 401, { error: "Incorrect phone number or password" });
  }
  user = await syncAdminStatus(user);

  const token = await createSession(user.id);
  const wallet = await getWallet(user.id);
  sendJson(res, 200, {
    token,
    user: getUserPublic(user),
    wallet_balance: koboToNaira(wallet.balance_kobo),
  });
}

async function handleGetWallet(req, res, userId) {
  const wallet = await getWallet(userId);
  sendJson(res, 200, { balance: koboToNaira(wallet.balance_kobo) });
}

// Step 1 of funding: create a pending transaction and ask the payment
// provider for a reference / checkout link. No money has moved yet.
async function handleFundInitiate(req, res, userId) {
  const body = await readJsonBody(req);
  const amountNaira = Number(body.amount);
  if (!amountNaira || amountNaira <= 0) {
    return sendJson(res, 400, { error: "amount must be a positive number" });
  }

  const amountKobo = nairaToKobo(amountNaira);
  const user = await db.get("SELECT email FROM users WHERE id = ?", [userId]);
  const { reference, checkoutUrl } = await paymentProvider.initiatePayment({
    amountKobo,
    userId,
    email: user.email, // real Paystack requires an email on the initialize call
  });

  const txId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO transactions (id, user_id, type, amount_kobo, status, provider_ref, created_at, updated_at)
     VALUES (?, ?, 'wallet_funding', ?, 'pending', ?, ?, ?)`,
    [txId, userId, amountKobo, reference, now, now]
  );

  sendJson(res, 200, { transaction_id: txId, reference, checkout_url: checkoutUrl });
}

// Step 2 of funding: verify with the provider, then credit the wallet.
// This is what the frontend calls right after checkout. The Paystack
// webhook below (handlePaystackWebhook) does the same job independently —
// see fundingEngine.js for how the two stay safely idempotent together.
async function handleFundVerify(req, res, userId) {
  const body = await readJsonBody(req);
  const { reference } = body;
  if (!reference) return sendJson(res, 400, { error: "reference is required" });

  const tx = await db.get(
    "SELECT * FROM transactions WHERE provider_ref = ? AND user_id = ?",
    [reference, userId]
  );
  if (!tx) return sendJson(res, 404, { error: "No matching transaction for that reference" });
  if (tx.status !== "pending") {
    return sendJson(res, 200, { status: tx.status, message: "Already processed" });
  }

  const result = await paymentProvider.verifyPayment({ reference });
  const settled = await settleFunding(
    tx.id,
    { status: result.status, reason: result.reason },
    tx.amount_kobo,
    userId
  );

  if (settled.status === "success") {
    const wallet = await getWallet(userId);
    return sendJson(res, 200, { status: "success", new_balance: koboToNaira(wallet.balance_kobo) });
  }
  return sendJson(res, 200, { status: "failed", reason: result.reason });
}

// ---------- Paystack webhook ----------
//
// This is the RELIABLE path for confirming payment — unlike the frontend
// calling /api/wallet/fund/verify (which never fires if the user closes
// the app mid-checkout), Paystack calls this endpoint from their own
// servers once a charge finishes, regardless of what the user's browser
// does. Configure this URL in your Paystack dashboard under
// Settings → API Keys & Webhooks.
//
// Security: there is NO Authorization header here — Paystack can't send
// your app's session tokens, it doesn't have any. Instead, every webhook
// call is signed: Paystack computes an HMAC-SHA512 of the raw request
// body using your secret key and sends it in the `x-paystack-signature`
// header. We recompute that same HMAC ourselves and compare — if they
// don't match byte-for-byte, the request either wasn't really from
// Paystack or was tampered with in transit, so we reject it. This is the
// ONLY thing standing between this endpoint and anyone on the internet
// being able to credit arbitrary wallets, so it is not optional.
async function handlePaystackWebhook(req, res) {
  const raw = await readRawBody(req);
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret) {
    // Fail loudly rather than silently accepting unverifiable webhooks.
    // Returning 500 also makes Paystack retry once the key is configured.
    console.error("[webhook] PAYSTACK_SECRET_KEY is not set — rejecting webhook");
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Webhook secret not configured" }));
  }

  const signature = req.headers["x-paystack-signature"] || "";
  const expected = crypto.createHmac("sha512", secret).update(raw).digest("hex");

  // Compare as raw bytes, not strings, and only via a timing-safe function —
  // a naive `signature === expected` leaks timing information an attacker
  // could use to guess the correct signature one byte at a time.
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  const validSignature = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

  if (!validSignature) {
    console.warn("[webhook] Rejected — invalid Paystack signature");
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid signature" }));
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid JSON" }));
  }

  // Signature is verified — we can trust this payload now.
  try {
    if (event.event === "charge.success" || event.event === "charge.failed") {
      const reference = event.data && event.data.reference;
      const tx = await db.get(
        "SELECT * FROM transactions WHERE provider_ref = ? AND type = 'wallet_funding'",
        [reference]
      );

      if (!tx) {
        console.warn("[webhook] No matching transaction for reference:", reference);
      } else {
        const result =
          event.event === "charge.success"
            ? { status: "success" }
            : { status: "failed", reason: "Paystack reported charge.failed" };
        const settled = await settleFunding(tx.id, result, tx.amount_kobo, tx.user_id);
        console.log(`[webhook] ${event.event} for ${reference}:`, settled);
      }
    } else {
      console.log(`[webhook] Ignoring unhandled event type: ${event.event}`);
    }
  } catch (err) {
    // A genuine internal error (e.g. DB hiccup) — 500 so Paystack retries,
    // since retrying might actually succeed next time.
    console.error("[webhook] Error processing event:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Internal error" }));
  }

  // Always 200 once we've verified + handled (or deliberately ignored) the
  // event — this tells Paystack "received, don't retry," even for event
  // types we don't act on or references we don't recognize.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ received: true }));
}

// ---------- purchases (airtime & data) ----------
//
// Pattern used here, and why:
// 1. Reserve funds immediately (debit wallet + insert transaction as
//    'pending') inside one atomic DB transaction. This is what stops two
//    quick taps of "Confirm & Pay" from both succeeding when there's only
//    enough balance for one — the second request's balance check will
//    correctly see the already-reduced balance.
// 2. THEN call the VTU provider (a slow network call) outside the DB lock.
// 3. On success: mark the transaction 'success'. Money stays deducted.
// 4. On failure: mark 'failed' AND refund the wallet. Net cost to the user
//    is zero, but there's never a window where the same funds could be
//    spent twice.
// 5. On pending (provider didn't confirm either way): leave the funds
//    deducted and the transaction 'pending' — the reconciliation job
//    (reconcile.js) picks these up automatically.
//
// reserveFunds, settleTransaction, and verifyPin live in purchaseEngine.js,
// shared with the reconciliation job.

async function handleBuyAirtime(req, res, userId) {
  const body = await readJsonBody(req);
  const { network, phone, amount, pin, idempotency_key } = body;

  if (!VALID_NETWORKS.includes(network)) {
    return sendJson(res, 400, { error: "network must be one of: " + VALID_NETWORKS.join(", ") });
  }
  if (!/^\d{11}$/.test(String(phone || ""))) {
    return sendJson(res, 400, { error: "phone must be an 11-digit number" });
  }
  const amountNaira = Number(amount);
  if (!amountNaira || amountNaira <= 0) {
    return sendJson(res, 400, { error: "amount must be a positive number" });
  }
  if (!(await verifyPin(userId, pin))) {
    return sendJson(res, 401, { error: "Incorrect transaction PIN" });
  }

  const amountKobo = nairaToKobo(amountNaira);
  const reserved = await reserveFunds({
    userId,
    amountKobo,
    type: "airtime",
    network,
    phone,
    idempotencyKey: idempotency_key,
  });
  if (!reserved.ok) {
    if (reserved.duplicate) {
      return sendJson(res, 200, { message: "Already submitted", transaction: reserved.duplicate });
    }
    return sendJson(res, reserved.statusCode, { error: reserved.error });
  }

  const result = await vtuProvider.deliverAirtime({ network, phone, amountKobo });
  await settleTransaction(reserved.txId, result, amountKobo, userId);

  const wallet = await getWallet(userId);
  sendJson(res, 200, {
    transaction_id: reserved.txId,
    status: result.status,
    reason: result.reason,
    wallet_balance: koboToNaira(wallet.balance_kobo),
  });
}

async function handleBuyData(req, res, userId) {
  const body = await readJsonBody(req);
  const { phone, plan_id, pin, idempotency_key } = body;

  if (!/^\d{11}$/.test(String(phone || ""))) {
    return sendJson(res, 400, { error: "phone must be an 11-digit number" });
  }
  if (!plan_id) {
    return sendJson(res, 400, { error: "plan_id is required" });
  }

  // Always the authoritative source of truth for price — read fresh from
  // the database on every purchase, never from anything the client sent.
  // A client can send whatever plan_id it wants, but it can never send an
  // amount for a data purchase; the price charged is always whatever this
  // lookup returns at this exact moment, which is also exactly what makes
  // "customers always see the current active price" true rather than just
  // a UI nicety — the backend enforces it too.
  const plan = await plans.getPlanById(plan_id);
  if (!plan || plan.is_active !== 1) {
    return sendJson(res, 400, { error: "This data plan is not currently available" });
  }
  if (!(await verifyPin(userId, pin))) {
    return sendJson(res, 401, { error: "Incorrect transaction PIN" });
  }

  // Network comes from the plan record, not from the client — a plan's
  // network is fixed by whoever set it up in the admin catalog, so there's
  // no legitimate reason for the client to override it, and trusting a
  // client-supplied network here would let mismatched (network, price)
  // pairs slip through.
  const reserved = await reserveFunds({
    userId,
    amountKobo: plan.selling_price_kobo,
    type: "data",
    network: plan.network,
    phone,
    planLabel: plan.label,
    planId: plan.id,
    providerCostKobo: plan.provider_cost_kobo,
    idempotencyKey: idempotency_key,
  });
  if (!reserved.ok) {
    if (reserved.duplicate) {
      return sendJson(res, 200, { message: "Already submitted", transaction: reserved.duplicate });
    }
    return sendJson(res, reserved.statusCode, { error: reserved.error });
  }

  const result = await vtuProvider.deliverData({
    network: plan.network,
    phone,
    planLabel: plan.label,
    amountKobo: plan.selling_price_kobo,
    variationCode: plan.variation_code,
  });
  await settleTransaction(reserved.txId, result, plan.selling_price_kobo, userId);

  const wallet = await getWallet(userId);
  sendJson(res, 200, {
    transaction_id: reserved.txId,
    status: result.status,
    reason: result.reason,
    wallet_balance: koboToNaira(wallet.balance_kobo),
  });
}

// ---------- data plan catalog ----------

// Customer-facing — active plans only, no provider cost. Read fresh from
// the database on every call (see plans.js) so this always reflects
// whatever an admin has most recently set, with no caching layer that
// could serve a stale price.
async function handleGetPlans(req, res, url) {
  const network = url.searchParams.get("network");
  const list = await plans.listActivePlans(network || undefined);
  sendJson(res, 200, { plans: list });
}

// ---------- admin: plan management ----------
// Every one of these is gated by requireAdmin at the router level below —
// none of these handler functions re-checks that on their own, so it's
// worth being extra sure the router never routes to one of these without
// requireAdmin running first (see the router section).

async function handleAdminListPlans(req, res) {
  const list = await plans.listAllPlans();
  sendJson(res, 200, { plans: list });
}

async function handleAdminCreatePlan(req, res, adminUserId) {
  const body = await readJsonBody(req);
  const { network, label, validity, provider_cost, selling_price, variation_code, is_active } = body;

  if (!VALID_NETWORKS.includes(network)) {
    return sendJson(res, 400, { error: "network must be one of: " + VALID_NETWORKS.join(", ") });
  }
  if (!label || !validity) {
    return sendJson(res, 400, { error: "label and validity are required" });
  }
  const providerCostNaira = Number(provider_cost);
  const sellingPriceNaira = Number(selling_price);
  if (!providerCostNaira || providerCostNaira <= 0) {
    return sendJson(res, 400, { error: "provider_cost must be a positive number" });
  }
  if (!sellingPriceNaira || sellingPriceNaira <= 0) {
    return sendJson(res, 400, { error: "selling_price must be a positive number" });
  }

  const created = await plans.createPlan(
    { network, label, validity, providerCostNaira, sellingPriceNaira, variationCode: variation_code, isActive: is_active },
    adminUserId
  );
  sendJson(res, 201, { plan: created });
}

async function handleAdminUpdatePlan(req, res, adminUserId, planId) {
  const body = await readJsonBody(req);
  const updates = {};

  if (body.network !== undefined) {
    if (!VALID_NETWORKS.includes(body.network)) {
      return sendJson(res, 400, { error: "network must be one of: " + VALID_NETWORKS.join(", ") });
    }
    updates.network = body.network;
  }
  if (body.label !== undefined) updates.label = body.label;
  if (body.validity !== undefined) updates.validity = body.validity;
  if (body.variation_code !== undefined) updates.variationCode = body.variation_code;
  if (body.provider_cost !== undefined) {
    const n = Number(body.provider_cost);
    if (!n || n <= 0) return sendJson(res, 400, { error: "provider_cost must be a positive number" });
    updates.providerCostNaira = n;
  }
  if (body.selling_price !== undefined) {
    const n = Number(body.selling_price);
    if (!n || n <= 0) return sendJson(res, 400, { error: "selling_price must be a positive number" });
    updates.sellingPriceNaira = n;
  }

  const updated = await plans.updatePlan(planId, updates, adminUserId);
  if (!updated) return sendJson(res, 404, { error: "No plan found with that id" });
  sendJson(res, 200, { plan: updated });
}

async function handleAdminSetPlanActive(req, res, adminUserId, planId, isActive) {
  const updated = await plans.setPlanActive(planId, isActive, adminUserId);
  if (!updated) return sendJson(res, 404, { error: "No plan found with that id" });
  sendJson(res, 200, { plan: updated });
}

async function handleAdminPlanHistory(req, res, planId) {
  const plan = await plans.getPlanById(planId);
  if (!plan) return sendJson(res, 404, { error: "No plan found with that id" });
  const history = await plans.getPlanPriceHistory(planId);
  sendJson(res, 200, { history });
}


async function handleGetTransactions(req, res, userId, url) {
  const status = url.searchParams.get("status"); // pending | success | failed
  const type = url.searchParams.get("type"); // wallet_funding | airtime | data
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);

  let query = "SELECT * FROM transactions WHERE user_id = ?";
  const params = [userId];
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  if (type) {
    query += " AND type = ?";
    params.push(type);
  }
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const rows = await db.all(query, params);
  const transactions = rows.map((r) => ({
    id: r.id,
    type: r.type,
    network: r.network,
    phone: r.phone,
    plan_label: r.plan_label,
    amount: koboToNaira(r.amount_kobo),
    status: r.status,
    failure_reason: r.failure_reason,
    created_at: r.created_at,
  }));

  sendJson(res, 200, { transactions });
}


    // ---------- static frontend ----------
// Serves the plain HTML/JS app in ./public at the same origin as the API,
// so the browser never has to deal with CORS. This is what makes
// "the frontend talks to the backend" work with zero extra config.
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  // guard against path traversal (e.g. /../../etc/passwd)
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "a-square-data-sub" });
    }
    if (req.method === "POST" && pathname === "/api/auth/register") {
      return await handleRegister(req, res);
    }
    if (req.method === "POST" && pathname === "/api/auth/login") {
      return await handleLogin(req, res);
    }
    if (req.method === "GET" && pathname === "/api/wallet") {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      return await handleGetWallet(req, res, userId);

    
    if (req.method === "POST" && pathname === "/api/wallet/fund/initiate") {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      return await handleFundInitiate(req, res, userId);
    }
    if (req.method === "POST" && pathname === "/api/wallet/fund/verify") {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      return await handleFundVerify(req, res, userId);
    }
    if (req.method === "POST" && pathname === "/api/purchase/airtime") {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      return await handleBuyAirtime(req, res, userId);
    }
    if (req.method === "POST" && pathname === "/api/purchase/data") {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      return await handleBuyData(req, res, userId);
    }
    if (req.method === "GET" && pathname === "/api/transactions") {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      return await handleGetTransactions(req, res, userId, url);
    }
    if (req.method === "GET" && pathname === "/api/plans") {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      return await handleGetPlans(req, res, url);
    }

    // ---- admin: plan management ----
    // Every branch here calls requireAdmin FIRST, before touching the
    // pathname further — so there's no route below this comment that a
    // non-admin (or unauthenticated) request can reach.
    if (pathname === "/api/admin/plans" && req.method === "GET") {
      const adminId = await requireAdmin(req, res);
      if (!adminId) return;
      return await handleAdminListPlans(req, res);
    }
    if (pathname === "/api/admin/plans" && req.method === "POST") {
      const adminId = await requireAdmin(req, res);
      if (!adminId) return;
      return await handleAdminCreatePlan(req, res, adminId);
    }
    {
      const activateMatch = pathname.match(/^\/api\/admin\/plans\/([^/]+)\/activate$/);
      if (activateMatch && req.method === "POST") {
        const adminId = await requireAdmin(req, res);
        if (!adminId) return;
        return await handleAdminSetPlanActive(req, res, adminId, activateMatch[1], true);
      }
      const deactivateMatch = pathname.match(/^\/api\/admin\/plans\/([^/]+)\/deactivate$/);
      if (deactivateMatch && req.method === "POST") {
        const adminId = await requireAdmin(req, res);
        if (!adminId) return;
        return await handleAdminSetPlanActive(req, res, adminId, deactivateMatch[1], false);
      }
      const historyMatch = pathname.match(/^\/api\/admin\/plans\/([^/]+)\/history$/);
      if (historyMatch && req.method === "GET") {
        const adminId = await requireAdmin(req, res);
        if (!adminId) return;
        return await handleAdminPlanHistory(req, res, historyMatch[1]);
      }
      const singlePlanMatch = pathname.match(/^\/api\/admin\/plans\/([^/]+)$/);
      if (singlePlanMatch && req.method === "PATCH") {
        const adminId = await requireAdmin(req, res);
        if (!adminId) return;
        return await handleAdminUpdatePlan(req, res, adminId, singlePlanMatch[1]);
      }
    }
    // Manual trigger for the reconciliation job — handy for testing without
    // waiting for the interval, and a natural fit for a "Retry" button in
    // the UI later. Requires auth just so it isn't wide open to the public;
    // it reconciles ALL users' pending transactions, not just the caller's.
    if (req.method === "POST" && pathname === "/api/admin/reconcile") {
      const adminId = await requireAdmin(req, res);
      if (!adminId) return;
      const results = await reconcileNow();
      return sendJson(res, 200, { checked: results.length, results });
    }
    // No requireAuth here on purpose — see the big comment on
    // handlePaystackWebhook for why signature verification IS the auth.
    if (req.method === "POST" && pathname === "/api/webhooks/paystack") {
      return await handlePaystackWebhook(req, res);
    }

    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  } catch (err) {
    if (err.message === "Invalid JSON body") {
      // A malformed request body is the client's mistake, not a server
      // failure — 400, not 500.
      return sendJson(res, 400, { error: "Invalid JSON in request body" });
    }
    console.error(err);
    sendJson(res, 500, { error: "Something went wrong on our end", detail: err.message });
  }
});

// db.ready resolves immediately for SQLite, and once the schema has been
// created for Postgres — either way, no request is handled before the
// tables exist.
db.ready.then(async () => {
  await plans.seedDefaultPlansIfEmpty();
  server.listen(PORT, () => {
    console.log(`A Square Data Sub backend (${db.name} database) running on http://localhost:${PORT}`);
    // Sweep for pending transactions every 30s. In production you'd likely
    // widen this to a few minutes — 30s here just makes it easy to watch
    // happen during testing.
    startReconciliationLoop(30_000);
    console.log("Reconciliation job scheduled: checks pending transactions every 30s");
  });
}).catch((err) => {
  console.error("Failed to start — database not ready:", err);
  process.exit(1);
});
