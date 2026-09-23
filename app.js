// app.js — A Square Data Sub frontend.
// Plain JS, no framework, no build step. Talks to the backend that's
// serving this very file, so all API calls are same-origin — open
// http://localhost:4000 after `node server.js` and everything just works.

// ---------- constants (mirror the backend's values for display) ----------
const NETWORKS = [
  { id: "mtn", name: "MTN", color: "#FFCC00", dark: true },
  { id: "airtel", name: "Airtel", color: "#ED1C24", dark: false },
  { id: "glo", name: "Glo", color: "#00A651", dark: false },
  { id: "9mobile", name: "9mobile", color: "#00A99D", dark: false },
];
// Data plans are NOT hardcoded here — they're fetched live from
// GET /api/plans every time the Buy Data screen opens (see actions.startData
// and actions.pickNetwork), which is what guarantees a customer always sees
// whatever price is currently active, even if an admin changed it moments
// ago. See S.plans below.
const AIRTIME_QUICK = [100, 200, 500, 1000, 2000, 5000];

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7"/><path d="M5 10v9h14v-9"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/></svg>',
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>',
};

// ---------- state ----------
const S = {
  token: null,
  user: null,
  screen: "loading", // loading, login, register, home, airtime, data, confirm, result, wallet-topup, topup-result, history, profile
  tab: "home",
  balance: 0,
  transactions: [],
  historyFilter: "",
  flowType: null, // 'airtime' | 'data'
  network: null,
  phone: "",
  airtimeAmount: null,
  customAmount: "",
  dataPlan: null,
  plans: [], // fetched live from /api/plans — see loadPlans()
  plansLoading: false,
  pin: "",
  idempotencyKey: null,
  topupAmount: "",
  loading: false,
  lastResult: null,
  formError: null,
};

// ---------- API helper ----------
async function api(pathname, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && S.token) headers["Authorization"] = "Bearer " + S.token;
  const res = await fetch(pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const err = new Error(data.error || "Request failed (" + res.status + ")");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- helpers ----------
function formatNaira(n) {
  return "\u20A6" + Number(n).toLocaleString("en-NG");
}
function timeAgo(iso) {
  // Timestamps from the backend are always proper ISO 8601 with a "Z"
  // (generated in application code, not by the database), so this can
  // parse directly — no reformatting needed.
  const then = new Date(iso).getTime();
  const diff = Math.floor((Date.now() - then) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}
function networkById(id) {
  return NETWORKS.find((n) => n.id === id);
}
function planById(id) {
  return S.plans.find((p) => p.id === id);
}
function currentAmount() {
  if (S.flowType === "airtime") {
    return S.customAmount ? parseInt(S.customAmount, 10) : S.airtimeAmount || 0;
  }
  if (S.flowType === "data" && S.dataPlan) {
    return planById(S.dataPlan).price;
  }
  return 0;
}
function resetFlow() {
  S.flowType = null;
  S.network = null;
  S.phone = "";
  S.airtimeAmount = null;
  S.customAmount = "";
  S.dataPlan = null;
  S.pin = "";
  S.idempotencyKey = null;
  S.formError = null;
}

function persistSession() {
  if (S.token) localStorage.setItem("asquare_token", S.token);
  if (S.user) localStorage.setItem("asquare_user", JSON.stringify(S.user));
}
function clearSession() {
  localStorage.removeItem("asquare_token");
  localStorage.removeItem("asquare_user");
  S.token = null;
  S.user = null;
}

async function refreshWallet() {
  const w = await api("/api/wallet");
  S.balance = w.balance;
}
async function loadTransactions() {
  const qs = S.historyFilter ? "?status=" + S.historyFilter : "";
  const t = await api("/api/transactions" + qs);
  S.transactions = t.transactions;
}
// Fetched fresh every time the Buy Data screen opens — no caching, so a
// price change an admin just made shows up immediately, not on next login.
async function loadPlans() {
  S.plansLoading = true;
  try {
    const r = await api("/api/plans");
    S.plans = r.plans;
  } finally {
    S.plansLoading = false;
  }
}

// ---------- actions (called from bindEvents via data-action) ----------
const actions = {
  async doLogin() {
    S.formError = null;
    const phone = document.getElementById("f-phone").value.trim();
    const password = document.getElementById("f-password").value;
    if (!phone || !password) {
      S.formError = "Enter your phone number and password";
      return render();
    }
    S.loading = true;
    render();
    try {
      const data = await api("/api/auth/login", { method: "POST", body: { phone, password }, auth: false });
      S.token = data.token;
      S.user = data.user;
      S.balance = data.wallet_balance;
      persistSession();
      await loadTransactions();
      S.screen = "home";
      S.tab = "home";
    } catch (e) {
      S.formError = e.message;
    }
    S.loading = false;
    render();
  },

  async doRegister() {
    S.formError = null;
    const full_name = document.getElementById("r-name").value.trim();
    const phone = document.getElementById("r-phone").value.trim();
    const email = document.getElementById("r-email").value.trim();
    const password = document.getElementById("r-password").value;
    const pin = document.getElementById("r-pin").value;
    if (!full_name || !phone || !password || !pin) {
      S.formError = "Please fill in all required fields";
      return render();
    }
    S.loading = true;
    render();
    try {
      const data = await api("/api/auth/register", {
        method: "POST",
        body: { full_name, phone, email, password, pin },
        auth: false,
      });
      S.token = data.token;
      S.user = data.user;
      S.balance = data.wallet_balance;
      persistSession();
      await loadTransactions();
      S.screen = "home";
      S.tab = "home";
    } catch (e) {
      S.formError = e.message;
    }
    S.loading = false;
    render();
  },

  goToLogin() {
    S.formError = null;
    S.screen = "login";
    render();
  },
  goToRegister() {
    S.formError = null;
    S.screen = "register";
    render();
  },
  logout() {
    clearSession();
    resetFlow();
    S.screen = "login";
    render();
  },

  goHome() {
    resetFlow();
    S.screen = "home";
    S.tab = "home";
    render();
  },
  goTab(el) {
    const tab = el.dataset.tab;
    S.tab = tab;
    S.screen = tab;
    if (tab === "history") loadTransactions().then(render);
    render();
  },

  startAirtime() {
    resetFlow();
    S.flowType = "airtime";
    S.screen = "airtime";
    render();
  },
  startData() {
    resetFlow();
    S.flowType = "data";
    S.screen = "data";
    render();
    // Fetch fresh prices every time this screen opens — not on app load,
    // not cached from last time. Fire-and-render again once it resolves.
    loadPlans().then(render);
  },
  pickNetwork(el) {
    S.network = networkById(el.dataset.id);
    // A plan picked under a different network doesn't apply here — drop it
    // so "Continue" can't proceed with a (network, plan) mismatch.
    if (S.flowType === "data") S.dataPlan = null;
    render();
  },
  pickAirtimeAmount(el) {
    S.airtimeAmount = Number(el.dataset.amount);
    S.customAmount = "";
    render();
  },
  pickDataPlan(el) {
    S.dataPlan = el.dataset.id;
    render();
  },
  goToConfirm() {
    if (!S.network || !/^\d{11}$/.test(S.phone) || currentAmount() <= 0) return;
    S.idempotencyKey = crypto.randomUUID();
    S.formError = null;
    S.screen = "confirm";
    render();
  },
  backToFlow() {
    S.screen = S.flowType;
    render();
  },

  async confirmAndPay() {
    const pin = document.getElementById("c-pin").value;
    if (!/^\d{4}$/.test(pin)) {
      S.formError = "Enter your 4-digit PIN";
      return render();
    }
    S.pin = pin;
    S.loading = true;
    S.formError = null;
    render();
    try {
      const endpoint = S.flowType === "airtime" ? "/api/purchase/airtime" : "/api/purchase/data";
      const body =
        S.flowType === "airtime"
          ? { network: S.network.id, phone: S.phone, amount: currentAmount(), pin: S.pin, idempotency_key: S.idempotencyKey }
          // No "network" sent for data — the backend derives it from the
          // plan itself (plan_id), which is also the authoritative source
          // for price. Sending one here would just be ignored server-side.
          : { phone: S.phone, plan_id: S.dataPlan, pin: S.pin, idempotency_key: S.idempotencyKey };
      const data = await api(endpoint, { method: "POST", body });
      S.lastResult = { ...data, type: S.flowType, amount: currentAmount() };
      S.balance = data.wallet_balance;
      await loadTransactions();
      S.screen = "result";
    } catch (e) {
      S.formError = e.message;
      S.loading = false;
      return render();
    }
    S.loading = false;
    render();
  },

  doneResult() {
    resetFlow();
    S.screen = "home";
    S.tab = "home";
    render();
  },

  goToTopup() {
    S.formError = null;
    S.topupAmount = "";
    S.screen = "wallet-topup";
    render();
  },
  pickTopupAmount(el) {
    S.topupAmount = el.dataset.amount;
    render();
  },
  async doTopup() {
    const amount = Number(S.topupAmount);
    if (!amount || amount <= 0) {
      S.formError = "Enter an amount to fund";
      return render();
    }
    S.loading = true;
    S.formError = null;
    render();
    try {
      const init = await api("/api/wallet/fund/initiate", { method: "POST", body: { amount } });
      const verify = await api("/api/wallet/fund/verify", { method: "POST", body: { reference: init.reference } });
      S.lastResult = { status: verify.status, amount, reason: verify.reason };
      if (verify.status === "success") S.balance = verify.new_balance;
      await loadTransactions();
      S.screen = "topup-result";
    } catch (e) {
      S.formError = e.message;
    }
    S.loading = false;
    render();
  },

  filterHistory(el) {
    S.historyFilter = el.dataset.status || "";
    loadTransactions().then(render);
  },
};

// ---------- screen renderers ----------
function iconBtn(name, extraClass) {
  return `<span class="${extraClass || ""}">${ICONS[name]}</span>`;
}

function screenLogin() {
  return `
  <div style="padding:60px 26px 0;">
    <h1 style="font-size:24px;">A Square Data Sub</h1>
    <p style="color:var(--muted);font-size:13px;margin-top:6px;">Log in to your wallet</p>
    ${S.formError ? `<div class="error-banner">${S.formError}</div>` : ""}
    <div style="margin-top:24px;display:flex;flex-direction:column;gap:12px;">
      <input id="f-phone" placeholder="Phone number" inputmode="numeric" maxlength="11" />
      <input id="f-password" placeholder="Password" type="password" />
    </div>
    <div style="margin-top:22px;">
      <button class="btn-primary" data-action="doLogin" ${S.loading ? "disabled" : ""}>
        ${S.loading ? '<span class="spinner"></span>Logging in…' : "Log in"}
      </button>
    </div>
    <button class="btn-link" data-action="goToRegister" style="width:100%;text-align:center;margin-top:14px;">
      New here? Create an account
    </button>
  </div>`;
}

function screenRegister() {
  return `
  <div style="padding:40px 26px 40px;">
    <h1 style="font-size:22px;">Create your account</h1>
    <p style="color:var(--muted);font-size:13px;margin-top:6px;">Start buying airtime & data in minutes</p>
    ${S.formError ? `<div class="error-banner">${S.formError}</div>` : ""}
    <div style="margin-top:20px;display:flex;flex-direction:column;gap:12px;">
      <input id="r-name" placeholder="Full name" />
      <input id="r-phone" placeholder="Phone number (11 digits)" inputmode="numeric" maxlength="11" />
      <input id="r-email" placeholder="Email (optional)" type="email" />
      <input id="r-password" placeholder="Password (min 6 characters)" type="password" />
      <input id="r-pin" placeholder="4-digit transaction PIN" inputmode="numeric" maxlength="4" />
    </div>
    <div style="margin-top:20px;">
      <button class="btn-primary" data-action="doRegister" ${S.loading ? "disabled" : ""}>
        ${S.loading ? '<span class="spinner"></span>Creating account…' : "Create account"}
      </button>
    </div>
    <button class="btn-link" data-action="goToLogin" style="width:100%;text-align:center;margin-top:14px;">
      Already have an account? Log in
    </button>
  </div>`;
}

function txRow(tx) {
  const net = networkById(tx.network);
  const statusColor = tx.status === "success" ? "var(--emerald)" : tx.status === "pending" ? "var(--gold)" : "var(--danger)";
  const isCredit = tx.type === "wallet_funding" && tx.status === "success";
  const label = tx.type === "wallet_funding" ? "Wallet top-up" : tx.type === "airtime" ? "Airtime" : "Data";
  const detail = tx.type === "wallet_funding" ? "Card funding" : tx.type === "data" ? `${tx.plan_label} · ${tx.phone}` : tx.phone;
  const logo = net
    ? `<div class="network-logo" style="width:36px;height:36px;background:${net.color};color:${net.dark ? "#0F1225" : "#fff"};font-size:12px;">${net.name.slice(0,2).toUpperCase()}</div>`
    : `<div class="network-logo" style="width:36px;height:36px;background:rgba(52,211,153,0.14);color:var(--emerald);">${ICONS.plus.replace('viewBox="0 0 24 24"','width="16" height="16" viewBox="0 0 24 24"')}</div>`;
  return `
  <div class="tx-row">
    ${logo}
    <div style="flex:1;min-width:0;">
      <p style="font-size:13.5px;font-weight:600;">${label}</p>
      <p style="font-size:11.5px;color:var(--muted);margin-top:2px;">${detail} · ${timeAgo(tx.created_at)}</p>
    </div>
    <div style="text-align:right;">
      <div style="font-family:var(--heading-font);font-weight:600;font-size:13.5px;color:${isCredit ? "var(--emerald)" : "var(--text)"};">
        ${isCredit ? "+" : "-"}${formatNaira(tx.amount)}
      </div>
      <div style="font-size:10px;color:${statusColor};text-transform:capitalize;margin-top:2px;">${tx.status}</div>
    </div>
  </div>`;
}

function screenHome() {
  const recent = S.transactions.slice(0, 3);
  return `
  <div style="padding-bottom:90px;">
    <div style="padding:22px 20px 0;">
      <p style="color:var(--muted);font-size:13px;">Good day</p>
      <h1 style="font-size:22px;margin-top:2px;">${S.user ? S.user.full_name.split(" ")[0] : ""}</h1>
    </div>
    <div class="card" style="margin:18px 20px 0;">
      <p style="color:var(--muted);font-size:12px;">Wallet balance</p>
      <h2 style="font-size:30px;margin:4px 0 16px;letter-spacing:-0.5px;">${formatNaira(S.balance)}</h2>
      <button class="btn-primary" style="width:auto;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;font-size:13px;border-radius:10px;" data-action="goToTopup">
        ${iconBtn("plus")} Fund wallet
      </button>
    </div>
    <div style="display:flex;gap:12px;margin:20px 20px 0;">
      <button data-action="startAirtime" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:10px;">
        <div style="width:34px;height:34px;border-radius:10px;background:rgba(242,183,5,0.14);display:flex;align-items:center;justify-content:center;color:var(--gold);">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>
        </div>
        <span style="font-size:13px;font-weight:600;">Buy Airtime</span>
      </button>
      <button data-action="startData" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:10px;">
        <div style="width:34px;height:34px;border-radius:10px;background:rgba(52,211,153,0.14);display:flex;align-items:center;justify-content:center;color:var(--emerald);">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5a10 10 0 0114 0M8 15.5a6 6 0 018 0M12 19h.01"/></svg>
        </div>
        <span style="font-size:13px;font-weight:600;">Buy Data</span>
      </button>
    </div>
    <div style="margin:26px 20px 12px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-family:var(--heading-font);font-size:15px;font-weight:600;">Recent activity</span>
      <button class="btn-link" data-action="goTab" data-tab="history" style="padding:0;">See all</button>
    </div>
    <div style="margin:0 20px;">
      ${recent.length ? recent.map(txRow).join("") : `<p style="color:var(--muted);font-size:12.5px;">No transactions yet.</p>`}
    </div>
  </div>`;
}

// Plans are filtered to the selected network, client-side, out of
// whatever loadPlans() most recently fetched — the fetch itself is what
// guarantees freshness (see actions.startData), this is just presentation.
function renderDataPlanOptions() {
  if (!S.network) {
    return `<p style="color:var(--muted);font-size:12.5px;">Select a network above to see available plans.</p>`;
  }
  if (S.plansLoading) {
    return `<p style="color:var(--muted);font-size:12.5px;"><span class="spinner" style="border-top-color:var(--muted);"></span>Loading current prices…</p>`;
  }
  const options = S.plans.filter((p) => p.network === S.network.id);
  if (!options.length) {
    return `<p style="color:var(--muted);font-size:12.5px;">No data plans are available on ${S.network.name} right now.</p>`;
  }
  return options
    .map(
      (p) => `
      <button data-action="pickDataPlan" data-id="${p.id}" style="display:flex;justify-content:space-between;align-items:center;padding:13px 14px;border-radius:12px;border:1.5px solid ${S.dataPlan === p.id ? "var(--gold)" : "var(--border)"};background:${S.dataPlan === p.id ? "var(--surface-alt)" : "transparent"};text-align:left;">
        <div>
          <p style="font-family:var(--heading-font);font-size:14px;font-weight:600;">${p.label}</p>
          <p style="font-size:11.5px;color:var(--muted);margin-top:2px;">Valid for ${p.validity}</p>
        </div>
        <span style="font-family:var(--heading-font);color:var(--gold);font-size:14px;font-weight:600;">${formatNaira(p.price)}</span>
      </button>`
    )
    .join("");
}

function screenPurchaseFlow() {
  const isAirtime = S.flowType === "airtime";
  const canContinue = S.network && /^\d{11}$/.test(S.phone) && currentAmount() > 0;
  return `
  <div style="display:flex;align-items:center;gap:12px;padding:18px 20px 14px;">
    <button data-action="goHome" style="background:var(--surface-alt);border:none;border-radius:10px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;color:var(--text);">${iconBtn("back")}</button>
    <h1 style="font-size:19px;">${isAirtime ? "Buy Airtime" : "Buy Data"}</h1>
  </div>
  <div style="padding:0 20px 100px;">
    <p style="color:var(--muted);font-size:12.5px;margin:6px 0 10px;">Select network</p>
    <div style="display:flex;gap:10px;margin-bottom:22px;">
      ${NETWORKS.map(
        (n) => `
        <button data-action="pickNetwork" data-id="${n.id}" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px;border-radius:14px;background:${S.network?.id === n.id ? "var(--surface-alt)" : "transparent"};border:1.5px solid ${S.network?.id === n.id ? "var(--gold)" : "var(--border)"};">
          <div class="network-logo" style="width:32px;height:32px;background:${n.color};color:${n.dark ? "#0F1225" : "#fff"};font-size:11px;">${n.name.slice(0,2).toUpperCase()}</div>
          <span style="font-size:10.5px;">${n.name}</span>
        </button>`
      ).join("")}
    </div>
    <p style="color:var(--muted);font-size:12.5px;margin:0 0 8px;">Phone number</p>
    <input id="phone-input" placeholder="0803 000 0000" inputmode="numeric" maxlength="11" value="${S.phone}" style="margin-bottom:22px;" />
    ${
      isAirtime
        ? `
      <p style="color:var(--muted);font-size:12.5px;margin:0 0 8px;">Amount</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;">
        ${AIRTIME_QUICK.map(
          (a) => `
          <button data-action="pickAirtimeAmount" data-amount="${a}" style="padding:12px 0;border-radius:12px;border:1.5px solid ${S.airtimeAmount === a && !S.customAmount ? "var(--gold)" : "var(--border)"};background:${S.airtimeAmount === a && !S.customAmount ? "var(--surface-alt)" : "transparent"};color:var(--text);font-weight:600;font-size:13px;">${formatNaira(a)}</button>`
        ).join("")}
      </div>
      <input id="custom-amount-input" placeholder="Or enter custom amount" inputmode="numeric" value="${S.customAmount}" />
      `
        : `
      <p style="color:var(--muted);font-size:12.5px;margin:0 0 8px;">Choose a plan</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${renderDataPlanOptions()}
      </div>
      `
    }
  </div>
  <div style="position:absolute;bottom:20px;left:0;right:0;padding:0 20px;">
    <button class="btn-primary" data-action="goToConfirm" ${canContinue ? "" : "disabled"}>Continue</button>
  </div>`;
}

function screenConfirm() {
  const amt = currentAmount();
  return `
  <div style="display:flex;align-items:center;gap:12px;padding:18px 20px 14px;">
    <button data-action="backToFlow" style="background:var(--surface-alt);border:none;border-radius:10px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;color:var(--text);">${iconBtn("back")}</button>
    <h1 style="font-size:19px;">Confirm purchase</h1>
  </div>
  <div style="padding:10px 20px 100px;">
    ${S.formError ? `<div class="error-banner">${S.formError}</div>` : ""}
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;">
      <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted);font-size:13px;">Network</span><span style="font-size:13px;">${S.network.name}</span></div>
      <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted);font-size:13px;">Phone number</span><span style="font-size:13px;">${S.phone}</span></div>
      ${S.flowType === "data" ? `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted);font-size:13px;">Plan</span><span style="font-size:13px;">${planById(S.dataPlan).label} · ${planById(S.dataPlan).validity}</span></div>` : ""}
      <div style="display:flex;justify-content:space-between;padding:9px 0;"><span style="color:var(--muted);font-size:13px;">Amount</span><span style="font-family:var(--heading-font);color:var(--gold);font-weight:700;font-size:15px;">${formatNaira(amt)}</span></div>
    </div>
    <p style="color:var(--muted);font-size:12px;margin:14px 4px 18px;">Wallet balance after purchase: ${formatNaira(S.balance - amt)}</p>
    <p style="color:var(--muted);font-size:12.5px;margin:0 0 8px;">Enter your transaction PIN</p>
    <input id="c-pin" placeholder="4-digit PIN" inputmode="numeric" maxlength="4" type="password" />
  </div>
  <div style="position:absolute;bottom:20px;left:0;right:0;padding:0 20px;">
    <button class="btn-primary" data-action="confirmAndPay" ${S.loading ? "disabled" : ""}>
      ${S.loading ? '<span class="spinner"></span>Processing…' : "Confirm & Pay"}
    </button>
  </div>`;
}

function screenResult() {
  const r = S.lastResult;
  const cfg = {
    success: { icon: "check", color: "var(--emerald)", bg: "rgba(52,211,153,0.14)", title: "Purchase successful" },
    pending: { icon: "history", color: "var(--gold)", bg: "rgba(242,183,5,0.14)", title: "Purchase pending" },
    failed: { icon: "back", color: "var(--danger)", bg: "rgba(242,109,109,0.14)", title: "Purchase failed — refunded" },
  }[r.status];
  const detailText =
    r.status === "pending"
      ? "The network hasn't confirmed delivery yet. We'll update this in your transaction history — your balance stays reserved until it resolves."
      : r.status === "failed"
      ? `${r.reason || "The network declined this request."} Your wallet has been refunded in full.`
      : `${r.type === "airtime" ? "Airtime" : "Data"} purchase of ${formatNaira(r.amount)} was successful.`;
  return `
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:0 30px;text-align:center;">
    <div style="width:68px;height:68px;border-radius:34px;background:${cfg.bg};display:flex;align-items:center;justify-content:center;margin-bottom:18px;color:${cfg.color};">
      <span style="width:30px;height:30px;display:block;">${ICONS[cfg.icon]}</span>
    </div>
    <h2 style="font-size:19px;margin-bottom:6px;">${cfg.title}</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:24px;">${detailText}</p>
    <div style="width:100%;">
      <button class="btn-primary" data-action="doneResult">Done</button>
    </div>
  </div>`;
}
function screenWalletTopup() {
  const quick = [1000, 2000, 5000, 10000];
  return `
  <div style="display:flex;align-items:center;gap:12px;padding:18px 20px 14px;">
    <button data-action="goHome" style="background:var(--surface-alt);border:none;border-radius:10px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;color:var(--text);">${iconBtn("back")}</button>
    <h1 style="font-size:19px;">Fund wallet</h1>
  </div>
  <div style="padding:0 20px;">
    ${S.formError ? `<div class="error-banner">${S.formError}</div>` : ""}
    <p style="color:var(--muted);font-size:12.5px;margin:6px 0 10px;">Current balance: ${formatNaira(S.balance)}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
      ${quick.map(
        (a) => `<button data-action="pickTopupAmount" data-amount="${a}" style="padding:12px 0;border-radius:12px;border:1.5px solid ${String(S.topupAmount) === String(a) ? "var(--gold)" : "var(--border)"};background:${String(S.topupAmount) === String(a) ? "var(--surface-alt)" : "transparent"};color:var(--text);font-weight:600;font-size:13px;">${formatNaira(a)}</button>`
      ).join("")}
    </div>
    <input id="topup-input" placeholder="Enter amount" inputmode="numeric" value="${S.topupAmount}" style="margin-bottom:22px;" />
    <button class="btn-primary" data-action="doTopup" ${S.loading ? "disabled" : ""}>
      ${S.loading ? '<span class="spinner"></span>Processing…' : "Fund with card (simulated)"}
    </button>
  </div>`;
}

function screenTopupResult() {
  const r = S.lastResult;
  const ok = r.status === "success";
  return `
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:0 30px;text-align:center;">
    <div style="width:68px;height:68px;border-radius:34px;background:${ok ? "rgba(52,211,153,0.14)" : "rgba(242,109,109,0.14)"};display:flex;align-items:center;justify-content:center;margin-bottom:18px;color:${ok ? "var(--emerald)" : "var(--danger)"};">
      <span style="width:30px;height:30px;display:block;">${ICONS[ok ? "check" : "back"]}</span>
    </div>
    <h2 style="font-size:19px;margin-bottom:6px;">${ok ? "Wallet funded" : "Funding failed"}</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:24px;">
      ${ok ? `${formatNaira(r.amount)} added. New balance: ${formatNaira(S.balance)}` : (r.reason || "The simulated payment was declined. No money was deducted.")}
    </p>
    <div style="width:100%;">
      <button class="btn-primary" data-action="goHome">Done</button>
    </div>
  </div>`;
}

function screenHistory() {
  const filters = [
    { label: "All", value: "" },
    { label: "Success", value: "success" },
    { label: "Pending", value: "pending" },
    { label: "Failed", value: "failed" },
  ];
  return `
  <div style="padding-bottom:90px;">
    <div style="padding:22px 20px 10px;">
      <h1 style="font-size:20px;">Transactions</h1>
    </div>
    <div style="display:flex;gap:8px;margin:0 20px 14px;">
      ${filters
        .map(
          (f) => `<button data-action="filterHistory" data-status="${f.value}" style="padding:6px 12px;border-radius:20px;border:1px solid ${S.historyFilter === f.value ? "var(--gold)" : "var(--border)"};background:${S.historyFilter === f.value ? "var(--surface-alt)" : "transparent"};color:var(--text);font-size:11.5px;">${f.label}</button>`
        )
        .join("")}
    </div>
    <div style="margin:0 20px;">
      ${S.transactions.length ? S.transactions.map(txRow).join("") : `<p style="color:var(--muted);font-size:12.5px;">No transactions found.</p>`}
    </div>
  </div>`;
}

function screenProfile() {
  return `
  <div style="padding:22px 20px 90px;">
    <h1 style="font-size:20px;margin-bottom:20px;">Profile</h1>
    <div style="display:flex;align-items:center;gap:14px;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:16px;margin-bottom:18px;">
      <div style="width:50px;height:50px;border-radius:25px;background:var(--gold);display:flex;align-items:center;justify-content:center;font-family:var(--heading-font);font-weight:700;color:#1a1400;font-size:18px;">
        ${(S.user?.full_name || "?").charAt(0).toUpperCase()}
      </div>
      <div>
        <p style="font-family:var(--heading-font);font-size:15px;font-weight:600;">${S.user?.full_name || ""}</p>
        <p style="font-size:12px;color:var(--muted);margin-top:2px;">${S.user?.phone || ""}</p>
      </div>
    </div>
    <button data-action="logout" style="width:100%;padding:13px 0;border-radius:12px;border:1px solid var(--danger);background:none;color:var(--danger);font-weight:600;font-size:13.5px;">Log out</button>
  </div>`;
}

// ---------- master render ----------
function bottomNav() {
  const items = [
    { id: "home", icon: "home", label: "Home" },
    { id: "history", icon: "history", label: "History" },
    { id: "wallet", icon: "wallet", label: "Wallet" },
    { id: "profile", icon: "profile", label: "Profile" },
  ];
  return `
  <div class="bottom-nav">
    ${items
      .map(
        (it) => `
      <button class="nav-item ${S.tab === it.id ? "active" : ""}" data-action="goTab" data-tab="${it.id}">
        ${ICONS[it.icon]}
        <span>${it.label}</span>
      </button>`
      )
      .join("")}
  </div>`;
}
// "wallet" tab reuses the home wallet card in a simple standalone view
function screenWalletTab() {
  return `
  <div style="padding-bottom:90px;">
    <div style="padding:22px 20px 0;"><h1 style="font-size:20px;">Wallet</h1></div>
    <div class="card" style="margin:18px 20px 0;">
      <p style="color:var(--muted);font-size:12px;">Available balance</p>
      <h2 style="font-size:30px;margin:4px 0 16px;">${formatNaira(S.balance)}</h2>
      <button class="btn-primary" style="width:auto;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;font-size:13px;border-radius:10px;" data-action="goToTopup">${iconBtn("plus")} Fund wallet</button>
    </div>
    <div style="margin:26px 20px 12px;"><span style="font-family:var(--heading-font);font-size:15px;font-weight:600;">Funding history</span></div>
    <div style="margin:0 20px;">
      ${S.transactions.filter((t) => t.type === "wallet_funding").length ? S.transactions.filter((t) => t.type === "wallet_funding").map(txRow).join("") : `<p style="color:var(--muted);font-size:12.5px;">No funding history yet.</p>`}
    </div>
  </div>`;
}

const NO_NAV_SCREENS = ["login", "register", "loading", "airtime", "data", "confirm", "result", "wallet-topup", "topup-result"];

function render() {
  const container = document.getElementById("screen");
  let html;
  switch (S.screen) {
    case "loading": html = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;">Loading…</div>`; break;
    case "login": html = screenLogin(); break;
    case "register": html = screenRegister(); break;
    case "home": html = screenHome(); break;
    case "airtime": case "data": html = screenPurchaseFlow(); break;
    case "confirm": html = screenConfirm(); break;
    case "result": html = screenResult(); break;
    case "wallet-topup": html = screenWalletTopup(); break;
    case "topup-result": html = screenTopupResult(); break;
    case "history": html = screenHistory(); break;
    case "wallet": html = screenWalletTab(); break;
    case "profile": html = screenProfile(); break;
    default: html = screenHome();
  }
  container.innerHTML = html + (NO_NAV_SCREENS.includes(S.screen) ? "" : bottomNav());
  bindTextInputs();
}

// Keep text inputs uncontrolled between keystrokes (avoids losing cursor
// position on re-render) — just sync their value into state on input.
function bindTextInputs() {
  const map = {
    "phone-input": "phone",
    "custom-amount-input": "customAmount",
    "topup-input": "topupAmount",
  };
  Object.entries(map).forEach(([id, field]) => {
    const el = document.getElementById(id);
    if (el) {
      el.oninput = () => {
        S[field] = field === "phone" || field === "customAmount" ? el.value.replace(/[^0-9]/g, "") : el.value.replace(/[^0-9]/g, "");
        el.value = S[field];
        if (field === "customAmount") S.airtimeAmount = null;
        // toggle continue button without a full re-render (keeps focus)
        const btn = document.querySelector('[data-action="goToConfirm"]');
        if (btn) {
          const canContinue = S.network && /^\d{11}$/.test(S.phone) && currentAmount() > 0;
          btn.disabled = !canContinue;
        }
      };
    }
  });
}

// ---------- event delegation ----------
document.getElementById("screen").addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el);
});

// ---------- boot ----------
async function init() {
  S.token = localStorage.getItem("asquare_token");
  const storedUser = localStorage.getItem("asquare_user");
  if (S.token) {
    S.user = storedUser ? JSON.parse(storedUser) : null;
    try {
      await refreshWallet();
      await loadTransactions();
      S.screen = "home";
      S.tab = "home";
    } catch (e) {
      clearSession();
      S.screen = "login";
    }
  } else {
    S.screen = "login";
  }
  render();
}

init();
