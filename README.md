# A Square Data Sub — full app

A working airtime & data reselling app: registration, login, wallet,
wallet funding (with a real Paystack webhook), buy airtime/data,
transaction history, automatic reconciliation of pending purchases —
backend and frontend, connected, with a real-database production path.

Zero required dependencies for local dev — plain Node.js (uses the
built-in `node:sqlite` module, Node 22.5+). The frontend is plain HTML/JS
in `public/`, served by the same server that runs the API — one process,
one origin, no CORS to configure.

## Quick start

**1. Run the backend:**
```
node server.js
```
That's it — no `npm install` needed for local dev. You'll see:
```
A Square Data Sub backend (sqlite database) running on http://localhost:4000
Reconciliation job scheduled: checks pending transactions every 30s
```

**2. Run the frontend:** there's nothing separate to run — it's the plain
HTML/JS in `public/`, served automatically by the same command above.
Just open **http://localhost:4000** in a browser.

**3. Create your first admin account:** set `ADMIN_PHONES` to your phone
number *before* starting the server, then register normally with that
number through the app (or the API):
```
ADMIN_PHONES=08012345678 node server.js
```
Register (or log back in) using phone `08012345678` and that account is
now an admin — `is_admin: true` comes back in the login/register response.
There is no other way to become admin; see "Admin-controlled pricing"
below for why that's deliberate. Comma-separate for more than one admin.

**4. Configure Paystack:**
- Get API keys from your Paystack dashboard → Settings → API Keys & Webhooks.
- Set `PAYMENT_PROVIDER=paystack` and `PAYSTACK_SECRET_KEY=sk_test_...` to
  actually charge cards (leave both unset to keep using the built-in mock).
- Set the webhook URL in that same dashboard page to
  `https://yourdomain.com/api/webhooks/paystack`. `PAYSTACK_SECRET_KEY`
  must be set for the webhook to work even if `PAYMENT_PROVIDER` is still
  `mock` — the webhook's signature check always uses it.
- Use a `sk_test_...` key and verify the whole flow before ever switching
  to `sk_live_...`.

**5. Before production, you must:**
- Set `DATABASE_URL` to a real Postgres instance — SQLite is a local-dev
  convenience, not what you deploy with real users (see "Going live: real
  database" below; the Postgres path hasn't been run against a live
  database in this project's own dev environment, so test it yourself
  first with `docker compose up --build`).
- Set real `PAYSTACK_SECRET_KEY` / `VTU_API_KEY` / `VTU_SECRET_KEY` values
  and switch `PAYMENT_PROVIDER` / `VTU_PROVIDER` off `mock`.
- Map VTpass's actual data-plan variation codes onto your `data_plans`
  rows via `PATCH /api/admin/plans/:id` — the seeded starter plans don't
  have real ones.
- Put a reverse proxy (Caddy/Nginx) in front for HTTPS — this app speaks
  plain HTTP on its own. See `Caddyfile.example`.
- Set your own real `ADMIN_PHONES` — the value used during development
  should not carry over.
- Review `.env.example` top to bottom; nothing in it should be left as a
  placeholder.

The rest of this document is reference detail on all of the above.

## Run it (local dev)

```
node server.js
```

You'll see:
```
A Square Data Sub backend (sqlite database) running on http://localhost:4000
Reconciliation job scheduled: checks pending transactions every 30s
```

Open **http://localhost:4000** — that's the actual app. Register an
account, fund your wallet, buy airtime/data.

**To see every state on purpose:** the mock VTU provider reads the last
digit of the phone number —
- ends in `0` → purchase fails (auto-refunded)
- ends in `1` → purchase stays pending (the reconciliation job resolves it
  within ~30 seconds, or trigger it instantly with `POST /api/admin/reconcile`)
- anything else → succeeds most of the time

A file `asquare.db` is created automatically. Delete it any time to start
fresh (`npm run reset-db`) — this is required after pulling this version if
you have an older copy, since the schema changed (see "What changed" below).

## Endpoints

| Method | Path | Auth? | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | no | `{ full_name, phone, email, password, pin }` |
| POST | `/api/auth/login` | no | `{ phone, password }` → returns `token` |
| GET | `/api/wallet` | yes | current balance |
| POST | `/api/wallet/fund/initiate` | yes | `{ amount }` → `{ reference, checkout_url }` |
| POST | `/api/wallet/fund/verify` | yes | `{ reference }` → credits wallet if payment succeeded |
| POST | `/api/webhooks/paystack` | signature | Paystack calls this directly — see below |
| GET | `/api/plans` | yes | active data plans + current prices; optional `?network=` |
| POST | `/api/purchase/airtime` | yes | `{ network, phone, amount, pin, idempotency_key? }` |
| POST | `/api/purchase/data` | yes | `{ phone, plan_id, pin, idempotency_key? }` — price & network come from the plan, never from the client |
| GET | `/api/transactions` | yes | optional `?status=` and `?type=` filters |
| POST | `/api/admin/reconcile` | admin | manually run the reconciliation sweep now |
| GET | `/api/admin/plans` | admin | list every plan, including inactive, with provider cost + margin |
| POST | `/api/admin/plans` | admin | `{ network, label, validity, provider_cost, selling_price, variation_code? }` |
| PATCH | `/api/admin/plans/:id` | admin | update any subset of the same fields |
| POST | `/api/admin/plans/:id/activate` | admin | make a plan purchasable again |
| POST | `/api/admin/plans/:id/deactivate` | admin | hide a plan from customers immediately |
| GET | `/api/admin/plans/:id/history` | admin | full audit trail of price/cost changes for one plan |

Auth: send `Authorization: Bearer <token>` on every request after login.
Admin routes need that same token to belong to an admin account — see
"Admin-controlled pricing" below for how that's decided.

Networks: `mtn`, `airtel`, `glo`, `9mobile`. Data plan prices are NOT fixed
in code — see the next section.

## Admin-controlled pricing

Data plans and their prices live in the database (`data_plans` table), not
in any source file — an admin can add, edit, price, activate, and
deactivate plans entirely through the API, with changes taking effect
immediately and with **no redeploy, no restart**. This was tested directly:
a price change made via `PATCH /api/admin/plans/:id` was visible to a
customer's very next `GET /api/plans` call, and the very next purchase was
charged at the new price.

**How "admin" is decided — and why it's safe:**
`users.is_admin` is a real column, but there is no API endpoint, anywhere,
that lets a request set it. It's controlled entirely by the `ADMIN_PHONES`
environment variable (comma-separated phone numbers) — `syncAdminStatus()`
in `server.js` checks that list on every login/register and updates the
flag to match. An attacker with a stolen session token still can't grant
themselves admin through the API; the only way in is having access to the
server's own deployment configuration. Every admin route is gated by
`requireAdmin()` (`auth.js`), checked before the route handler runs at all.

**Provider cost vs. selling price, kept strictly separate:**
- `provider_cost_kobo` — what the VTU provider charges you. Only ever
  returned by admin routes.
- `selling_price_kobo` — what the customer pays. This is the ONLY figure
  `GET /api/plans` (or anything else customer-facing) ever returns —
  verified directly: the customer-facing response contains no
  `provider_cost` or `margin` field at all, not even a zeroed one.
- The purchase flow (`handleBuyData` in `server.js`) always reads
  `selling_price_kobo` fresh from the database at the moment of purchase —
  a client can send a `plan_id`, but never an amount, for a data purchase.
  There is no code path where a client-supplied price is trusted.

**Audit trail:** every plan creation and every price/cost change is logged
to `plan_price_history` — who changed it (`changed_by`, an admin user id),
and the exact old/new values. Nothing is ever deleted from this table.
`GET /api/admin/plans/:id/history` returns it for one plan.

**Historical accuracy:** each transaction snapshots the plan's
`selling_price_kobo` and `provider_cost_kobo` *at the moment of purchase*
onto the transaction row itself (`plan_id` + `provider_cost_kobo` columns
on `transactions`). If an admin raises a price tomorrow, last week's
transactions still show what was actually charged and actually cost back
then — profit reporting doesn't quietly rewrite history. Verified directly:
two purchases of the same plan at two different prices (₦200 then ₦450,
after an admin price change in between) both still show their own correct
historical amount in transaction history.

**Getting your first admin account:** set `ADMIN_PHONES` before starting
the server, then register (or log back in, if already registered) with
that phone number:
```
ADMIN_PHONES=08012345678 node server.js
```
Add more phone numbers comma-separated (`ADMIN_PHONES=phone1,phone2`) for
more admins.

**Starter catalog:** on a completely empty `data_plans` table, the server
seeds 24 illustrative plans (6 sizes × 4 networks) on boot, at the same
prices this app previously had hardcoded, with provider cost guessed at
~85% of selling price. This never runs again once any plan exists, and
never overwrites anything an admin has changed — it's a first-boot
convenience only. Edit or delete the seeded plans via the admin API once
you have real provider costs.

## The security pattern used for purchases

1. Check balance and debit the wallet **immediately**, inside one atomic
   database transaction, before calling the VTU provider (`purchaseEngine.js`
   → `reserveFunds`). Stops two fast taps of "Confirm & Pay" from both
   going through when there's only enough money for one.
2. Call the VTU provider (the slow network call) afterwards.
3. Success → transaction marked `success`, money stays deducted.
4. Failure → wallet is **refunded** automatically, transaction marked
   `failed`. Net cost to the user is zero.
5. Pending → funds stay held, transaction marked `pending`, picked up
   automatically by the reconciliation job.

Also enforced: a 4-digit transaction PIN on every purchase, and an
`idempotency_key` from the frontend so a retried request never charges
twice.

## Paystack webhook (`/api/webhooks/paystack`)

This is the **reliable** way to confirm a payment — `/api/wallet/fund/verify`
only fires if the user's browser is still open and calls it; the webhook
fires from Paystack's own servers regardless of what the user's browser
does, so it's the one you actually depend on in production.

**How it's secured:** every webhook call from Paystack is signed — they
compute an HMAC-SHA512 of the exact request body using your secret key and
send it in the `x-paystack-signature` header. `handlePaystackWebhook` in
`server.js` recomputes that same HMAC and compares it byte-for-byte
(via `crypto.timingSafeEqual`, to avoid leaking timing information). A
request with no signature, a wrong signature, or a signature computed with
the wrong secret is rejected with 401 before any data is touched at all.

**Set it up:**
1. Set `PAYSTACK_SECRET_KEY` in your environment (needed regardless of
   whether `PAYMENT_PROVIDER` is `mock` or `paystack` — the webhook always
   verifies against this).
2. In your Paystack dashboard → Settings → API Keys & Webhooks, set the
   webhook URL to `https://yourdomain.com/api/webhooks/paystack`.
3. That's it — Paystack will call it automatically on every charge.

**Idempotent by design:** the webhook and `/api/wallet/fund/verify` both
call the same `settleFunding()` function (`fundingEngine.js`), which checks
"is this transaction still pending?" inside an atomic transaction before
crediting anything. Whichever one arrives first wins; the other becomes a
safe no-op. This was tested directly, including firing both at the same
instant on purpose.

## Reconciliation job (`reconcile.js`)

Runs automatically every 30 seconds. For every transaction still sitting at
`pending`, it calls `vtuProvider.checkStatus()` and settles it through the
same `settleTransaction()` the live purchase flow uses. Stops retrying a
given transaction after 10 attempts (`MAX_ATTEMPTS`) — those would need a
human to look at them in a real deployment. `POST /api/admin/reconcile`
triggers a sweep immediately instead of waiting.

## Environment variables

See `.env.example` for the full list with explanations. Load them with
Node's built-in support (no `dotenv` package needed):
```
node --env-file=.env server.js
```
or `npm run start:env`.

Summary:
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | what port the server listens on |
| `DATABASE_URL` | *(unset → SQLite)* | Postgres connection string — set this to go to a real production DB |
| `DATABASE_SSL` | *(unset → SSL on)* | set to `false` for a local Postgres with no SSL |
| `PAYMENT_PROVIDER` | `mock` | `mock` or `paystack` |
| `PAYSTACK_SECRET_KEY` | — | required for `paystack` provider AND for the webhook |
| `VTU_PROVIDER` | `mock` | `mock` or `vtpass` |
| `VTU_API_KEY` / `VTU_SECRET_KEY` | — | required for `vtpass` provider |
| `VTU_BASE_URL` | VTpass production URL | point at their sandbox while testing |
| `ADMIN_PHONES` | *(unset → no admins)* | comma-separated phone numbers granted admin access on login/register |

## Going live: real database (Postgres)

The whole data layer (`db.js` + `db-adapters/`) is built around one shared
async interface (`get`, `all`, `run`, `exec`, `transaction`) that every
other file uses — no file talks to SQLite or Postgres directly. That's
what makes switching a one-variable change instead of a rewrite:

```
DATABASE_URL=postgres://user:pass@host:5432/dbname node server.js
```

Needs the `pg` package, which is **not** installed by default (kept out of
the zero-setup local dev path on purpose):
```
npm install pg
```

**Honesty about testing:** `db-adapters/postgres.js` was written to match
`pg` v8's documented API and the exact same query patterns already proven
correct against SQLite in this project — but it has not been run against a
live Postgres server, because this project was built in a sandbox with no
network access to reach one. Before trusting it with real user data:

1. **Test it locally first** with the included Docker setup — this spins
   up the app AND a real Postgres together:
   ```
   docker compose up --build
   ```
   Open http://localhost:4000 and run through registration, funding, and
   a purchase. If something's off, it'll show up immediately.
2. Only after that, point `DATABASE_URL` at your real production Postgres
   (Render, Railway, Supabase, and RDS all give you a connection string
   directly in their dashboard).

**Moving from SQLite to Postgres does not migrate existing data** — this
project doesn't include a data-migration script, since a fresh production
deploy normally starts with an empty database anyway. If you need to carry
over real SQLite data, that's a separate one-time export/import step this
build doesn't cover.

## Going live: real payment & VTU providers

Both `providers/paymentProvider.js` (Paystack) and `providers/vtuProvider.js`
(VTpass) have complete, real implementations already written — switch with
environment variables, no code changes:

```
PAYMENT_PROVIDER=paystack PAYSTACK_SECRET_KEY=sk_test_xxxxx \
VTU_PROVIDER=vtpass VTU_API_KEY=xxxxx VTU_SECRET_KEY=xxxxx \
node server.js
```

**Before touching real money:**
1. **Paystack** — use a `sk_test_...` key first. Only switch to `sk_live_...`
   once you've verified the flow end-to-end, webhook included.
2. **VTpass** — they offer a free sandbox with its own demo keys and base
   URL (set `VTU_BASE_URL`) — use that before any real key touches your
   server.
3. Double-check both providers' current API docs before going live —
   these implementations match their documented shape as of when this was
   written:
   - Paystack: https://paystack.com/docs
   - VTpass: https://vtpass.com/documentation
4. **Data plan variation codes are still placeholders** — VTpass identifies
   each data bundle by a code specific to their catalog. Map `DATA_PLANS`
   in `server.js` to VTpass's actual codes (from their
   `/api/service-variations` endpoint) before data purchases work for real.
   Airtime doesn't need this.

## Deploying the server itself

Two ready-to-use options are included:

**Docker** (`Dockerfile` + `docker-compose.yml`) — works with any host that
runs containers (a VPS, Render, Railway, Fly.io, etc.):
```
docker compose up --build
```

**Plain Linux server** (`asquare.service.example`) — a systemd unit if
you're deploying directly onto a VPS without Docker. Copy it to
`/etc/systemd/system/asquare.service`, adjust the paths, then
`systemctl enable --now asquare`. Restarts automatically on crash or reboot.

**HTTPS** — this app speaks plain HTTP; put a reverse proxy in front of it
for real deployments. `Caddyfile.example` is the simplest option (automatic
free HTTPS certificates, zero manual certificate management) — copy it to
`Caddyfile` on your server, point your domain's DNS at the server, and run
`caddy run`.

## What changed in this version (upgrade notes)

If you have an earlier copy of this project:
- User IDs are now UUIDs, not auto-incrementing numbers (needed to work
  identically across SQLite and Postgres) — delete `asquare.db` and start
  fresh, there's no in-place migration for this.
- Timestamps are now generated in application code as ISO 8601, not by the
  database — same reason (portability), same fix (fresh database).
- `reserveFunds`, `settleTransaction`, `settleFunding`, and `verifyPin` are
  now `async` — if you had custom code calling these directly, add `await`.
- Data plans moved from a hardcoded object in `server.js` into the
  `data_plans` database table — delete `asquare.db` to get the starter
  catalog seeded fresh. `handleBuyData` no longer accepts a client-supplied
  `network`; it's derived from the plan.
- `/api/admin/reconcile` now requires an actual admin account
  (`requireAdmin`), not just any logged-in user (`requireAuth`) — tightened
  once real admin roles existed, since the endpoint reconciles every
  user's pending transactions, not just the caller's.

## Not yet built (good next steps)

- A background job to auto-retry transactions stuck at `MAX_ATTEMPTS` in
  reconciliation, or surface them for manual review
- Rate limiting on login/purchase endpoints
- A real data-migration script for SQLite → Postgres (if you need to carry
  over existing data rather than starting fresh)
- The Postgres adapter has not been run against a live database — see
  "Going live: real database" above
