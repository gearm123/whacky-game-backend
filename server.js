import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { ensureDatabaseSchema, getPool, isDatabaseUrlConfigured, pingDatabase } from "./db.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3001;
const REFILL_AMOUNT = 2000;
const GUEST_STARTING_BALANCE = 2000;
const SESSION_DAYS = Math.max(1, Number(process.env.AUTH_SESSION_DAYS) || 30);
const USER_WALLET_CURRENCY = "USER_COINS";
const GUEST_WALLET_CURRENCY = "GUEST_COINS";

const guestUser = {
  id: "guest-user",
  username: "guest-player",
  displayName: "Guest Player",
  billingProfile: "guest-demo-coins",
};

const guestWallet = {
  userId: guestUser.id,
  currency: GUEST_WALLET_CURRENCY,
  balance: GUEST_STARTING_BALANCE,
  version: 1,
  updatedAt: new Date().toISOString(),
};

const guestLedger = [];
const refillRequests = [];

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

function now() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMoney(value) {
  return Number(value).toFixed(2);
}

function parseDbMoney(value) {
  return Number.parseFloat(String(value ?? "0"));
}

function moneyToDb(value) {
  return formatMoney(value);
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function getAdminCredentials() {
  return {
    username: (process.env.ADMIN_USERNAME || "").trim(),
    password: (process.env.ADMIN_PASSWORD || "").trim(),
  };
}

function isAdminAuthConfigured() {
  const admin = getAdminCredentials();
  return Boolean(admin.username && admin.password);
}

function normalizeUsername(value) {
  const username = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    throw new Error("Username must be 3-24 characters using letters, numbers, or underscores.");
  }

  return {
    username,
    normalized: username.toLowerCase(),
  };
}

function parsePassword(value) {
  const password = String(value ?? "");
  if (password.length < 4 || password.length > 128) {
    throw new Error("Password must be between 4 and 128 characters.");
  }
  return password;
}

function parseGuestId(value) {
  const guestId = String(value ?? "").trim();
  if (!guestId) {
    throw new Error("A guestId is required.");
  }

  if (guestId.length > 120) {
    throw new Error("guestId is too long.");
  }

  return guestId;
}

function parsePositiveCoins(value, fieldName = "amount") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }

  if (amount > 1_000_000_000) {
    throw new Error(`${fieldName} is too large.`);
  }

  return Number(amount.toFixed(2));
}

function parseNonNegativeCoins(value, fieldName = "amount") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${fieldName} must be zero or greater.`);
  }

  if (amount > 1_000_000_000) {
    throw new Error(`${fieldName} is too large.`);
  }

  return Number(amount.toFixed(2));
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derivedKey}`;
}

function verifyPassword(password, passwordHash) {
  const [scheme, salt, expectedHex] = String(passwordHash).split(":");
  if (scheme !== "scrypt" || !salt || !expectedHex) {
    return false;
  }

  const actualBuffer = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expectedHex, "hex");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function readBearerToken(request) {
  const header = String(request.headers.authorization ?? "");
  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function serializeRefillRequest(requestRecord) {
  return {
    id: requestRecord.id,
    guestId: requestRecord.guestId,
    amount: requestRecord.amount,
    status: requestRecord.status,
    createdAt: requestRecord.createdAt,
    approvedAt: requestRecord.approvedAt,
    rejectedAt: requestRecord.rejectedAt,
    claimedAt: requestRecord.claimedAt,
    updatedAt: requestRecord.updatedAt,
  };
}

function serializeGuestWallet() {
  return {
    userId: guestWallet.userId,
    currency: guestWallet.currency,
    balance: guestWallet.balance,
    version: guestWallet.version,
    updatedAt: guestWallet.updatedAt,
    canSettleFromFrontend: true,
    walletType: "guest_demo",
    walletLabel: "Guest Demo Coins",
    isGuestWallet: true,
  };
}

function serializeUserWallet(row) {
  return {
    userId: row.user_id,
    currency: row.currency,
    balance: parseDbMoney(row.balance),
    updatedAt: new Date(row.updated_at).toISOString(),
    canSettleFromFrontend: true,
    walletType: "signed_in_user",
    walletLabel: "Signed-In Player Coins",
    isGuestWallet: false,
  };
}

function serializeLedgerEntry(row) {
  return {
    id: row.id,
    type: row.entry_type,
    amount: parseDbMoney(row.amount),
    currency: row.currency,
    balanceAfter: parseDbMoney(row.balance_after),
    referenceId: row.reference_id,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function createRefillRequestId() {
  return createId("refill");
}

function getRefillRequest(requestId) {
  return refillRequests.find((entry) => entry.id === requestId) ?? null;
}

function getActiveRefillRequestForGuest(guestId) {
  return (
    refillRequests.find(
      (entry) => entry.guestId === guestId && (entry.status === "pending" || entry.status === "approved"),
    ) ?? null
  );
}

function updateRefillRequestStatus(requestRecord, status) {
  const updatedAt = now();
  requestRecord.status = status;
  requestRecord.updatedAt = updatedAt;

  if (status === "approved") {
    requestRecord.approvedAt = updatedAt;
  }

  if (status === "rejected") {
    requestRecord.rejectedAt = updatedAt;
  }

  if (status === "claimed") {
    requestRecord.claimedAt = updatedAt;
  }

  return requestRecord;
}

function renderAdminShell(title, intro, content, extraNotice = "") {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="refresh" content="5" />
        <title>${escapeHtml(title)}</title>
        <style>
          :root {
            color-scheme: dark;
            font-family: Arial, sans-serif;
          }
          body {
            margin: 0;
            padding: 24px;
            background: #081021;
            color: #f3f7ff;
          }
          h1, h2, p {
            margin-top: 0;
          }
          nav {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
            flex-wrap: wrap;
          }
          nav a {
            color: #9dd7ff;
            text-decoration: none;
            font-weight: 700;
          }
          .summary {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 20px;
          }
          .card {
            min-width: 160px;
            padding: 14px 16px;
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.08);
          }
          .notice {
            margin-bottom: 16px;
            padding: 12px 14px;
            border-radius: 14px;
            background: rgba(251, 191, 36, 0.12);
            border: 1px solid rgba(251, 191, 36, 0.2);
            color: #fde68a;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            background: rgba(255, 255, 255, 0.04);
            border-radius: 18px;
            overflow: hidden;
          }
          th, td {
            padding: 12px 14px;
            text-align: left;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            vertical-align: top;
          }
          th {
            color: #ffe08a;
            font-size: 0.86rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
          }
          code {
            color: #bfe3ff;
          }
          .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }
          .stack {
            display: grid;
            gap: 8px;
          }
          form {
            margin: 0;
          }
          input {
            width: 140px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 10px;
            padding: 10px 12px;
            background: rgba(255, 255, 255, 0.06);
            color: inherit;
          }
          button {
            cursor: pointer;
            border: 0;
            border-radius: 12px;
            padding: 10px 14px;
            font-weight: 700;
          }
          .approve {
            background: #6be49a;
            color: #10223a;
          }
          .secondary {
            background: #8dc9ff;
            color: #10223a;
          }
          .reject {
            background: #ff9696;
            color: #401515;
          }
          .muted {
            color: #abc0e5;
          }
        </style>
      </head>
      <body>
        <nav>
          <a href="/admin/users">Signed-in user balances</a>
          <a href="/admin/refill-requests">Guest refill requests</a>
        </nav>
        <h1>${escapeHtml(title)}</h1>
        <p class="muted">${escapeHtml(intro)}</p>
        ${extraNotice}
        ${content}
      </body>
    </html>
  `;
}

function renderGuestRefillActionButtons(requestRecord) {
  if (requestRecord.status !== "pending") {
    return '<span class="muted">No actions</span>';
  }

  return `
    <div class="actions">
      <form method="post" action="/admin/refill-requests/${encodeURIComponent(requestRecord.id)}/approve">
        <button type="submit" class="approve">Approve +${requestRecord.amount}</button>
      </form>
      <form method="post" action="/admin/refill-requests/${encodeURIComponent(requestRecord.id)}/reject">
        <button type="submit" class="reject">Reject</button>
      </form>
    </div>
  `;
}

function renderRefillRequestsAdminPage() {
  const requestRows = refillRequests.length
    ? refillRequests
        .map(
          (requestRecord) => `
            <tr>
              <td><code>${escapeHtml(requestRecord.id)}</code></td>
              <td><code>${escapeHtml(requestRecord.guestId)}</code></td>
              <td>${escapeHtml(requestRecord.status)}</td>
              <td>${requestRecord.amount}</td>
              <td>${escapeHtml(requestRecord.createdAt)}</td>
              <td>${escapeHtml(requestRecord.approvedAt ?? "-")}</td>
              <td>${escapeHtml(requestRecord.claimedAt ?? "-")}</td>
              <td>${renderGuestRefillActionButtons(requestRecord)}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="8" class="muted">No refill requests yet.</td></tr>';

  const pendingCount = refillRequests.filter((entry) => entry.status === "pending").length;
  const approvedCount = refillRequests.filter((entry) => entry.status === "approved").length;
  const claimedCount = refillRequests.filter((entry) => entry.status === "claimed").length;

  const content = `
    <div class="summary">
      <div class="card"><strong>Pending</strong><br />${pendingCount}</div>
      <div class="card"><strong>Approved</strong><br />${approvedCount}</div>
      <div class="card"><strong>Claimed</strong><br />${claimedCount}</div>
      <div class="card"><strong>Wallet Type</strong><br />Guest Demo Coins</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Request</th>
          <th>Guest</th>
          <th>Status</th>
          <th>Amount</th>
          <th>Created</th>
          <th>Approved</th>
          <th>Claimed</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${requestRows}</tbody>
    </table>
  `;

  return renderAdminShell(
    "Guest refill requests",
    `Guest demo coins stay separate from signed-in user balances. Approved guest refills add ${REFILL_AMOUNT} guest demo coins after the browser claims the request.`,
    content,
  );
}

function renderUserWalletAdminPage(rows) {
  const totalBalance = rows.reduce((sum, entry) => sum + parseDbMoney(entry.balance), 0);
  const notice = isAdminAuthConfigured()
    ? ""
    : '<div class="notice">Admin credentials are not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD before exposing this page outside local development.</div>';

  const requestRows = rows.length
    ? rows
        .map(
          (entry) => `
            <tr>
              <td>${escapeHtml(entry.username)}</td>
              <td>${formatMoney(entry.balance)} ${escapeHtml(entry.currency)}</td>
              <td>${escapeHtml(new Date(entry.updated_at).toISOString())}</td>
              <td>${escapeHtml(new Date(entry.created_at).toISOString())}</td>
              <td>
                <div class="stack">
                  <form class="actions" method="post" action="/admin/users/${encodeURIComponent(entry.user_id)}/add-coins">
                    <input type="number" min="0.01" step="0.01" name="amount" placeholder="Add coins" required />
                    <button type="submit" class="approve">Add Coins</button>
                  </form>
                  <form class="actions" method="post" action="/admin/users/${encodeURIComponent(entry.user_id)}/set-balance">
                    <input type="number" min="0" step="0.01" name="amount" placeholder="Set balance" required />
                    <button type="submit" class="secondary">Set Balance</button>
                  </form>
                </div>
              </td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="5" class="muted">No signed-in users yet.</td></tr>';

  const content = `
    <div class="summary">
      <div class="card"><strong>Signed-In Users</strong><br />${rows.length}</div>
      <div class="card"><strong>Total User Coins</strong><br />${formatMoney(totalBalance)}</div>
      <div class="card"><strong>Wallet Type</strong><br />Signed-In Player Coins</div>
      <div class="card"><strong>Guest Coins</strong><br />Managed separately</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Username</th>
          <th>Current Balance</th>
          <th>Updated</th>
          <th>Created</th>
          <th>Admin Actions</th>
        </tr>
      </thead>
      <tbody>${requestRows}</tbody>
    </table>
  `;

  return renderAdminShell(
    "Signed-in user balances",
    "Choose a signed-in username from the database and either add more coins or set an exact balance. These balances are separate from guest demo coins.",
    content,
    notice,
  );
}

function requireAdmin(request, response) {
  const admin = getAdminCredentials();
  if (!admin.username || !admin.password) {
    return "admin-panel";
  }

  const header = String(request.headers.authorization ?? "");
  if (!header.startsWith("Basic ")) {
    response.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
    response.status(401).send("Admin authentication required.");
    return null;
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  if (username !== admin.username || password !== admin.password) {
    response.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
    response.status(401).send("Invalid admin credentials.");
    return null;
  }

  return admin.username;
}

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

async function ensureDatabaseAccess(response) {
  if (!isDatabaseUrlConfigured()) {
    response.status(503).json({
      error: "Database is not configured yet. Set DATABASE_URL to enable sign-in and persistent signed-in user balances.",
    });
    return false;
  }

  try {
    await ensureDatabaseSchema();
    return true;
  } catch (error) {
    console.error("Database schema check failed:", error);
    response.status(503).json({
      error: "Database is currently unavailable.",
    });
    return false;
  }
}

async function loadSessionByToken(token) {
  const tokenHash = hashToken(token);
  const pool = getPool();
  const sessionResult = await pool.query(
    `
      select
        s.id as session_id,
        s.user_id,
        s.expires_at,
        u.username,
        u.created_at as user_created_at,
        w.currency,
        w.balance,
        w.updated_at
      from app_sessions s
      join app_users u on u.id = s.user_id
      join app_wallets w on w.user_id = u.id
      where s.token_hash = $1
        and s.expires_at > now()
      limit 1
    `,
    [tokenHash],
  );

  const row = sessionResult.rows[0];
  if (!row) {
    return null;
  }

  await pool.query("update app_sessions set last_used_at = now() where id = $1", [row.session_id]);

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.username,
      createdAt: new Date(row.user_created_at).toISOString(),
      billingProfile: "signed-in-player-coins",
    },
    wallet: serializeUserWallet(row),
  };
}

async function requireUserSession(request, response) {
  const token = readBearerToken(request);
  if (!token) {
    response.status(401).json({ error: "Sign in is required for this action." });
    return null;
  }

  if (!(await ensureDatabaseAccess(response))) {
    return null;
  }

  const session = await loadSessionByToken(token);
  if (!session) {
    response.status(401).json({ error: "Session is invalid or expired." });
    return null;
  }

  return { ...session, token };
}

async function createUserAccount(usernameValue, passwordValue) {
  const { username, normalized } = normalizeUsername(usernameValue);
  const password = parsePassword(passwordValue);
  const passwordHash = hashPassword(password);
  const userId = randomUUID();
  const client = await getPool().connect();

  try {
    await client.query("begin");
    await client.query(
      `
        insert into app_users (id, username, username_normalized, password_hash)
        values ($1, $2, $3, $4)
      `,
      [userId, username, normalized, passwordHash],
    );
    await client.query(
      `
        insert into app_wallets (user_id, currency, balance, updated_at)
        values ($1, $2, 0, now())
      `,
      [userId, USER_WALLET_CURRENCY],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    if (error && typeof error === "object" && error.code === "23505") {
      throw new Error("That username is already taken.");
    }
    throw error;
  } finally {
    client.release();
  }

  return {
    id: userId,
    username,
    displayName: username,
    billingProfile: "signed-in-player-coins",
  };
}

async function verifyUserCredentials(usernameValue, passwordValue) {
  const { normalized } = normalizeUsername(usernameValue);
  const password = parsePassword(passwordValue);
  const result = await getPool().query(
    `
      select id, username, password_hash
      from app_users
      where username_normalized = $1
      limit 1
    `,
    [normalized],
  );

  const row = result.rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new Error("Invalid username or password.");
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.username,
    billingProfile: "signed-in-player-coins",
  };
}

async function createSessionForUser(userId) {
  const token = randomBytes(32).toString("hex");
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await getPool().query(
    `
      insert into app_sessions (id, user_id, token_hash, expires_at)
      values ($1, $2, $3, $4)
    `,
    [sessionId, userId, hashToken(token), expiresAt],
  );

  return {
    sessionId,
    token,
    expiresAt,
  };
}

async function loadWalletForUser(userId) {
  const result = await getPool().query(
    `
      select user_id, currency, balance, updated_at
      from app_wallets
      where user_id = $1
      limit 1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Wallet not found.");
  }

  return serializeUserWallet(row);
}

async function listLedgerForUser(userId) {
  const result = await getPool().query(
    `
      select id, entry_type, amount, currency, balance_after, reference_id, note, created_at
      from app_wallet_ledger
      where user_id = $1
      order by created_at desc
      limit 25
    `,
    [userId],
  );

  return result.rows.map(serializeLedgerEntry);
}

async function listAllUsersWithWallets() {
  const result = await getPool().query(
    `
      select
        w.user_id,
        u.username,
        u.created_at,
        w.currency,
        w.balance,
        w.updated_at
      from app_wallets w
      join app_users u on u.id = w.user_id
      order by lower(u.username) asc
    `,
  );

  return result.rows;
}

async function applyAdminBalanceAction(userId, mode, amount, actor) {
  const client = await getPool().connect();

  try {
    await client.query("begin");
    const result = await client.query(
      `
        select
          w.user_id,
          u.username,
          w.currency,
          w.balance,
          w.updated_at
        from app_wallets w
        join app_users u on u.id = w.user_id
        where w.user_id = $1
        for update
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("User wallet not found.");
    }

    const previousBalance = parseDbMoney(row.balance);
    const nextBalance = mode === "add" ? previousBalance + amount : amount;
    const delta = Number((nextBalance - previousBalance).toFixed(2));
    const entryType = mode === "add" ? "admin_add_coins" : "admin_set_balance";
    const note =
      mode === "add"
        ? `Admin ${actor} added ${formatMoney(amount)} signed-in player coins.`
        : `Admin ${actor} set balance from ${formatMoney(previousBalance)} to ${formatMoney(nextBalance)}.`;

    await client.query(
      `
        update app_wallets
        set balance = $1, updated_at = now()
        where user_id = $2
      `,
      [moneyToDb(nextBalance), row.user_id],
    );

    await client.query(
      `
        insert into app_wallet_ledger (
          id,
          user_id,
          entry_type,
          amount,
          currency,
          balance_after,
          reference_id,
          note
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [randomUUID(), row.user_id, entryType, moneyToDb(delta), row.currency, moneyToDb(nextBalance), null, note],
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function settleSignedInUserWallet(userId, { previousBalance, nextBalance, delta, reason }) {
  if (!Number.isFinite(previousBalance) || !Number.isFinite(nextBalance) || !Number.isFinite(delta)) {
    throw new Error("Wallet settlement requires numeric balances and delta.");
  }

  const normalizedReason = String(reason ?? "frontend_resolution").trim() || "frontend_resolution";
  const client = await getPool().connect();

  try {
    await client.query("begin");
    const walletResult = await client.query(
      `
        select user_id, currency, balance, updated_at
        from app_wallets
        where user_id = $1
        for update
      `,
      [userId],
    );

    const walletRow = walletResult.rows[0];
    if (!walletRow) {
      throw new Error("Wallet not found.");
    }

    const driftDetected = parseDbMoney(walletRow.balance) !== previousBalance;
    const updatedWalletResult = await client.query(
      `
        update app_wallets
        set balance = $1, updated_at = now()
        where user_id = $2
        returning user_id, currency, balance, updated_at
      `,
      [moneyToDb(nextBalance), userId],
    );

    const updatedWallet = updatedWalletResult.rows[0];

    await client.query(
      `
        insert into app_wallet_ledger (
          id,
          user_id,
          entry_type,
          amount,
          currency,
          balance_after,
          reference_id,
          note
        )
        values ($1, $2, 'frontend_spin_settle', $3, $4, $5, $6, $7)
      `,
      [
        randomUUID(),
        userId,
        moneyToDb(delta),
        updatedWallet.currency,
        moneyToDb(nextBalance),
        null,
        driftDetected ? `${normalizedReason} (drift detected)` : normalizedReason,
      ],
    );

    await client.query("commit");

    return {
      wallet: serializeUserWallet(updatedWallet),
      driftDetected,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

app.get(
  "/api/health",
  asyncHandler(async (_request, response) => {
    response.json({
      ok: true,
      databaseUrlConfigured: isDatabaseUrlConfigured(),
      databaseConnected: await pingDatabase(),
      guestWallet: serializeGuestWallet(),
      signedInWalletCurrency: USER_WALLET_CURRENCY,
    });
  }),
);

app.post(
  "/api/auth/signup",
  asyncHandler(async (request, response) => {
    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    const user = await createUserAccount(request.body?.username, request.body?.password);
    const session = await createSessionForUser(user.id);
    const wallet = await loadWalletForUser(user.id);

    response.status(201).json({
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      user,
      wallet,
    });
  }),
);

app.post(
  "/api/auth/signin",
  asyncHandler(async (request, response) => {
    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    const user = await verifyUserCredentials(request.body?.username, request.body?.password);
    const session = await createSessionForUser(user.id);
    const wallet = await loadWalletForUser(user.id);

    response.json({
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      user,
      wallet,
    });
  }),
);

app.post(
  "/api/auth/signout",
  asyncHandler(async (request, response) => {
    const session = await requireUserSession(request, response);
    if (!session) {
      return;
    }

    await getPool().query("delete from app_sessions where id = $1", [session.sessionId]);
    response.status(204).send();
  }),
);

app.get(
  "/api/me",
  asyncHandler(async (request, response) => {
    const token = readBearerToken(request);
    if (token) {
      if (!(await ensureDatabaseAccess(response))) {
        return;
      }

      const session = await loadSessionByToken(token);
      if (!session) {
        response.status(401).json({ error: "Session is invalid or expired." });
        return;
      }

      response.json({
        isGuest: false,
        user: session.user,
        wallet: session.wallet,
      });
      return;
    }

    response.json({
      isGuest: true,
      user: guestUser,
      wallet: serializeGuestWallet(),
    });
  }),
);

app.get(
  "/api/wallet",
  asyncHandler(async (request, response) => {
    const token = readBearerToken(request);
    if (token) {
      const session = await requireUserSession(request, response);
      if (!session) {
        return;
      }

      response.json({
        ...session.wallet,
        recentLedger: await listLedgerForUser(session.user.id),
      });
      return;
    }

    response.json({
      ...serializeGuestWallet(),
      recentLedger: [...guestLedger].reverse(),
    });
  }),
);

app.post("/api/refill-requests", (request, response) => {
  try {
    const guestId = parseGuestId(request.body?.guestId);
    const activeRequest = getActiveRefillRequestForGuest(guestId);

    if (activeRequest) {
      response.json({
        request: serializeRefillRequest(activeRequest),
        reusedExistingRequest: true,
      });
      return;
    }

    const createdAt = now();
    const requestRecord = {
      id: createRefillRequestId(),
      guestId,
      amount: REFILL_AMOUNT,
      status: "pending",
      createdAt,
      approvedAt: null,
      rejectedAt: null,
      claimedAt: null,
      updatedAt: createdAt,
    };

    refillRequests.unshift(requestRecord);

    response.status(201).json({
      request: serializeRefillRequest(requestRecord),
      reusedExistingRequest: false,
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Could not create refill request.",
    });
  }
});

app.get("/api/refill-requests/:requestId", (request, response) => {
  try {
    const guestId = parseGuestId(request.query?.guestId);
    const requestRecord = getRefillRequest(request.params.requestId);

    if (!requestRecord || requestRecord.guestId !== guestId) {
      response.status(404).json({ error: "Refill request not found." });
      return;
    }

    response.json({
      request: serializeRefillRequest(requestRecord),
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Could not load refill request.",
    });
  }
});

app.post("/api/refill-requests/:requestId/claim", (request, response) => {
  try {
    const guestId = parseGuestId(request.body?.guestId);
    const requestRecord = getRefillRequest(request.params.requestId);

    if (!requestRecord || requestRecord.guestId !== guestId) {
      response.status(404).json({ error: "Refill request not found." });
      return;
    }

    if (requestRecord.status !== "approved") {
      response.status(409).json({
        error: `Refill request is ${requestRecord.status} and cannot be claimed.`,
      });
      return;
    }

    updateRefillRequestStatus(requestRecord, "claimed");

    response.json({
      request: serializeRefillRequest(requestRecord),
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Could not claim refill request.",
    });
  }
});

app.get(
  "/admin",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    response.redirect("/admin/users");
  }),
);

app.get(
  "/admin/refill-requests",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    response.type("html").send(renderRefillRequestsAdminPage());
  }),
);

app.post(
  "/admin/refill-requests/:requestId/approve",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    const requestRecord = getRefillRequest(request.params.requestId);
    if (requestRecord && requestRecord.status === "pending") {
      updateRefillRequestStatus(requestRecord, "approved");
    }

    response.redirect("/admin/refill-requests");
  }),
);

app.post(
  "/admin/refill-requests/:requestId/reject",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    const requestRecord = getRefillRequest(request.params.requestId);
    if (requestRecord && requestRecord.status === "pending") {
      updateRefillRequestStatus(requestRecord, "rejected");
    }

    response.redirect("/admin/refill-requests");
  }),
);

app.get(
  "/admin/users",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    response.type("html").send(renderUserWalletAdminPage(await listAllUsersWithWallets()));
  }),
);

app.post(
  "/admin/users/:userId/add-coins",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    try {
      const amount = parsePositiveCoins(request.body?.amount, "Add coins amount");
      await applyAdminBalanceAction(request.params.userId, "add", amount, actor);
    } catch (error) {
      console.error("Admin add coins failed:", error);
    }

    response.redirect("/admin/users");
  }),
);

app.post(
  "/admin/users/:userId/set-balance",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    try {
      const amount = parseNonNegativeCoins(request.body?.amount, "Set balance amount");
      await applyAdminBalanceAction(request.params.userId, "set", amount, actor);
    } catch (error) {
      console.error("Admin set balance failed:", error);
    }

    response.redirect("/admin/users");
  }),
);

app.post(
  "/api/wallet/settle",
  asyncHandler(async (request, response) => {
    const token = readBearerToken(request);
    if (token) {
      const session = await requireUserSession(request, response);
      if (!session) {
        return;
      }

      const previousBalance = Number(request.body?.previousBalance);
      const nextBalance = Number(request.body?.nextBalance);
      const delta = Number(request.body?.delta ?? nextBalance - previousBalance);
      const reason = String(request.body?.reason ?? "frontend_resolution");

      const result = await settleSignedInUserWallet(session.user.id, {
        previousBalance,
        nextBalance,
        delta,
        reason,
      });

      response.json(result);
      return;
    }

    try {
      const previousBalance = Number(request.body?.previousBalance);
      const nextBalance = Number(request.body?.nextBalance);
      const delta = Number(request.body?.delta ?? nextBalance - previousBalance);
      const reason = String(request.body?.reason ?? "frontend_resolution");

      if (!Number.isFinite(previousBalance) || !Number.isFinite(nextBalance) || !Number.isFinite(delta)) {
        throw new Error("Wallet settlement requires numeric balances and delta.");
      }

      const driftDetected = guestWallet.balance !== previousBalance;
      guestWallet.balance = nextBalance;
      guestWallet.version += 1;
      guestWallet.updatedAt = new Date().toISOString();

      guestLedger.push({
        id: `${guestWallet.version}-${Date.now()}`,
        userId: guestWallet.userId,
        previousBalance,
        nextBalance,
        delta,
        reason,
        driftDetected,
        recordedAt: guestWallet.updatedAt,
      });

      response.json({
        wallet: serializeGuestWallet(),
        driftDetected,
      });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Unknown wallet settlement error.",
      });
    }
  }),
);

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({
    error: error instanceof Error ? error.message : "Internal server error.",
  });
});

try {
  await ensureDatabaseSchema();
} catch (error) {
  console.error("Postgres bootstrap failed:", error);
}

app.listen(port, () => {
  console.log(`Whacky Slot account service listening on http://localhost:${port}`);
});
