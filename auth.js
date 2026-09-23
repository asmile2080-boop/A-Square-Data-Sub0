// auth.js
const crypto = require("node:crypto");
const { db } = require("./db");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Password / PIN hashing (scrypt, built into Node — no bcrypt needed) ---

function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifySecret(plain, stored) {
  const [salt, hash] = stored.split(":");
  const attempt = crypto.scryptSync(plain, salt, 64).toString("hex");
  // timingSafeEqual to avoid leaking info via response-time differences
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(attempt, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Sessions ---

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.run(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [token, userId, new Date().toISOString(), expiresAt]
  );
  return token;
}

async function getUserIdFromToken(token) {
  if (!token) return null;
  const row = await db.get("SELECT user_id, expires_at FROM sessions WHERE token = ?", [token]);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await db.run("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  return row.user_id;
}

// Reads "Authorization: Bearer <token>", returns the user id, or responds
// 401 and returns null. Async because looking up the session hits the DB.
async function requireAuth(req, res) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = await getUserIdFromToken(token);
  if (!userId) {
    sendJson(res, 401, { error: "Not authenticated. Please log in again." });
    return null;
  }
  return userId;
}

// Same as requireAuth, but additionally requires users.is_admin = 1.
// There is deliberately no way to reach that flag except reading it — no
// endpoint anywhere sets is_admin from a request. It's only ever written
// by syncAdminStatus() in server.js, which checks the ADMIN_PHONES
// environment variable. An attacker with a valid login token still can't
// grant themselves admin through the API; only someone with access to the
// server's own environment configuration can.
async function requireAdmin(req, res) {
  const userId = await requireAuth(req, res);
  if (!userId) return null; // requireAuth already sent the 401

  const user = await db.get("SELECT is_admin FROM users WHERE id = ?", [userId]);
  if (!user || user.is_admin !== 1) {
    sendJson(res, 403, { error: "Admin access required" });
    return null;
  }
  return userId;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

module.exports = {
  hashSecret,
  verifySecret,
  createSession,
  getUserIdFromToken,
  requireAuth,
  requireAdmin,
  sendJson,
};
