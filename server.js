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

const guestUser = {
  id: "guest-user",
  username: "guest-player",
  displayName: "Guest Player",
  billingProfile: "guest-coins",
};

const guestWallet = {
  userId: guestUser.id,
  currency: "COINS",
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

function getTrueMoneyRecipient() {
  const label = (process.env.TRUEMONEY_RECIPIENT_NAME || "TrueMoney receiving account").trim();
  const account = (process.env.TRUEMONEY_RECIPIENT_ACCOUNT || "TO_BE_CONFIGURED").trim();
  const note = (
    process.env.TRUEMONEY_RECIPIENT_NOTE ||
    "Set TRUEMONEY_RECIPIENT_ACCOUNT before accepting live deposits."
  ).trim();

  return {
    label,
    account,
    note,
    configured: account !== "TO_BE_CONFIGURED",
  };
}

function getDepositInstructions() {
  const recipient = getTrueMoneyRecipient();

  return {
    ...recipient,
    currency: "THB",
    steps: [
      "Create a deposit request from the signed-in account.",
      `Transfer the exact requested THB amount to ${recipient.label}.`,
      "After the transfer is received, an admin approves the request from the backend admin panel.",
      "Approved requests add THB balance to the signed-in site wallet.",
    ],
  };
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

function parseDepositAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Deposit amount must be a positive number.");
  }

  if (amount > 1_000_000) {
    throw new Error("Deposit amount is too large.");
  }

  return Number(amount.toFixed(2));
}

function parseOptionalText(value, maxLength = 160) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  if (text.length > maxLength) {
    throw new Error(`Text field must be at most ${maxLength} characters.`);
  }

  return text;
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
  };
}

function serializeUserWallet(row) {
  return {
    userId: row.user_id,
    currency: row.currency,
    balance: parseDbMoney(row.balance),
    updatedAt: new Date(row.updated_at).toISOString(),
    canSettleFromFrontend: false,
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

function serializeDeposit(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    amount: parseDbMoney(row.amount),
    currency: row.currency,
    status: row.status,
    senderWalletId: row.sender_wallet_id,
    transferReference: row.transfer_reference,
    note: row.note,
    destinationLabel: row.destination_label,
    destinationAccount: row.destination_account,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    rejectedAt: row.rejected_at ? new Date(row.rejected_at).toISOString() : null,
    approvedBy: row.approved_by,
    rejectedBy: row.rejected_by,
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
            min-width: 140px;
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
          form {
            margin: 0;
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
          <a href="/admin/deposits">Manual deposits</a>
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
    `Open this page to approve a pending guest request. Approved requests add ${REFILL_AMOUNT} coins after the guest browser polls and claims the refill.`,
    content,
  );
}

function renderDepositActionButtons(requestRecord) {
  if (requestRecord.status !== "pending") {
    return '<span class="muted">No actions</span>';
  }

  return `
    <div class="actions">
      <form method="post" action="/admin/deposits/${encodeURIComponent(requestRecord.id)}/approve">
        <button type="submit" class="approve">Approve +${formatMoney(requestRecord.amount)} ${escapeHtml(requestRecord.currency)}</button>
      </form>
      <form method="post" action="/admin/deposits/${encodeURIComponent(requestRecord.id)}/reject">
        <button type="submit" class="reject">Reject</button>
      </form>
    </div>
  `;
}

function renderDepositsAdminPage(rows) {
  const pendingCount = rows.filter((entry) => entry.status === "pending").length;
  const approvedCount = rows.filter((entry) => entry.status === "approved").length;
  const rejectedCount = rows.filter((entry) => entry.status === "rejected").length;
  const recipient = getTrueMoneyRecipient();
  const notice = isAdminAuthConfigured()
    ? ""
    : '<div class="notice">Admin credentials are not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD before exposing this page outside local development.</div>';

  const requestRows = rows.length
    ? rows
        .map(
          (entry) => `
            <tr>
              <td><code>${escapeHtml(entry.id)}</code></td>
              <td>${escapeHtml(entry.username)}</td>
              <td>${formatMoney(entry.amount)} ${escapeHtml(entry.currency)}</td>
              <td>${escapeHtml(entry.status)}</td>
              <td><code>${escapeHtml(entry.transfer_reference ?? "-")}</code></td>
              <td><code>${escapeHtml(entry.sender_wallet_id ?? "-")}</code></td>
              <td>${escapeHtml(entry.created_at)}</td>
              <td>${escapeHtml(entry.approved_at ?? "-")}</td>
              <td>${renderDepositActionButtons({
                ...entry,
                amount: parseDbMoney(entry.amount),
              })}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="9" class="muted">No deposit requests yet.</td></tr>';

  const content = `
    <div class="summary">
      <div class="card"><strong>Pending</strong><br />${pendingCount}</div>
      <div class="card"><strong>Approved</strong><br />${approvedCount}</div>
      <div class="card"><strong>Rejected</strong><br />${rejectedCount}</div>
      <div class="card"><strong>Recipient</strong><br /><code>${escapeHtml(recipient.account)}</code></div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Request</th>
          <th>User</th>
          <th>Transfer amount</th>
          <th>Status</th>
          <th>Reference</th>
          <th>Sender wallet</th>
          <th>Created</th>
          <th>Approved</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${requestRows}</tbody>
    </table>
  `;

  return renderAdminShell(
    "Manual deposit approvals",
    "Review pending TrueMoney transfer requests and approve balance only after the receiving wallet confirms the transfer happened.",
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
      error: "Database is not configured yet. Set DATABASE_URL to enable sign-in and manual deposit storage.",
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
      billingProfile: "manual-truemoney-deposits",
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
        values ($1, 'THB', 0, now())
      `,
      [userId],
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
    billingProfile: "manual-truemoney-deposits",
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
    billingProfile: "manual-truemoney-deposits",
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

async function listDepositsForUser(userId) {
  const result = await getPool().query(
    `
      select
        d.*,
        u.username
      from deposit_requests d
      join app_users u on u.id = d.user_id
      where d.user_id = $1
      order by d.created_at desc
    `,
    [userId],
  );

  return result.rows.map(serializeDeposit);
}

async function listAllDeposits() {
  const result = await getPool().query(
    `
      select
        d.*,
        u.username
      from deposit_requests d
      join app_users u on u.id = d.user_id
      order by d.created_at desc
      limit 200
    `,
  );

  return result.rows;
}

async function createDepositRequest(userId, body) {
  const amount = parseDepositAmount(body?.amount);
  const senderWalletId = parseOptionalText(body?.senderWalletId, 120);
  const transferReference = parseOptionalText(body?.transferReference, 120);
  const note = parseOptionalText(body?.note, 240);
  const recipient = getTrueMoneyRecipient();
  const depositId = createId("deposit");

  const result = await getPool().query(
    `
      insert into deposit_requests (
        id,
        user_id,
        amount,
        currency,
        status,
        sender_wallet_id,
        transfer_reference,
        note,
        destination_label,
        destination_account
      )
      values ($1, $2, $3, 'THB', 'pending', $4, $5, $6, $7, $8)
      returning
        id,
        user_id,
        amount,
        currency,
        status,
        sender_wallet_id,
        transfer_reference,
        note,
        destination_label,
        destination_account,
        created_at,
        updated_at,
        approved_at,
        rejected_at,
        approved_by,
        rejected_by
    `,
    [depositId, userId, moneyToDb(amount), senderWalletId, transferReference, note, recipient.label, recipient.account],
  );

  const userResult = await getPool().query(
    `
      select username
      from app_users
      where id = $1
      limit 1
    `,
    [userId],
  );

  return serializeDeposit({
    ...result.rows[0],
    username: userResult.rows[0]?.username ?? "unknown",
  });
}

async function approveDepositRequest(depositId, actor) {
  const client = await getPool().connect();

  try {
    await client.query("begin");
    const result = await client.query(
      `
        select
          d.*,
          u.username,
          w.balance as wallet_balance
        from deposit_requests d
        join app_users u on u.id = d.user_id
        join app_wallets w on w.user_id = d.user_id
        where d.id = $1
        for update of d, w
      `,
      [depositId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Deposit request not found.");
    }

    if (row.status !== "pending") {
      throw new Error(`Deposit request is already ${row.status}.`);
    }

    const nextBalance = parseDbMoney(row.wallet_balance) + parseDbMoney(row.amount);

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
        update deposit_requests
        set status = 'approved',
            updated_at = now(),
            approved_at = now(),
            approved_by = $2
        where id = $1
      `,
      [depositId, actor],
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
        values ($1, $2, 'manual_deposit_approved', $3, $4, $5, $6, $7)
      `,
      [
        randomUUID(),
        row.user_id,
        moneyToDb(parseDbMoney(row.amount)),
        row.currency,
        moneyToDb(nextBalance),
        row.id,
        `Manual deposit approved by ${actor}`,
      ],
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function rejectDepositRequest(depositId, actor) {
  const result = await getPool().query(
    `
      update deposit_requests
      set status = 'rejected',
          updated_at = now(),
          rejected_at = now(),
          rejected_by = $2
      where id = $1
        and status = 'pending'
      returning id
    `,
    [depositId, actor],
  );

  if (!result.rows[0]) {
    throw new Error("Pending deposit request not found.");
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
      trueMoneyRecipientConfigured: getTrueMoneyRecipient().configured,
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
      depositInstructions: getDepositInstructions(),
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
      depositInstructions: getDepositInstructions(),
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
        depositInstructions: getDepositInstructions(),
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

app.get(
  "/api/deposit-instructions",
  asyncHandler(async (request, response) => {
    const session = await requireUserSession(request, response);
    if (!session) {
      return;
    }

    response.json({
      user: session.user,
      instructions: getDepositInstructions(),
    });
  }),
);

app.get(
  "/api/deposits",
  asyncHandler(async (request, response) => {
    const session = await requireUserSession(request, response);
    if (!session) {
      return;
    }

    response.json({
      deposits: await listDepositsForUser(session.user.id),
    });
  }),
);

app.post(
  "/api/deposits",
  asyncHandler(async (request, response) => {
    const session = await requireUserSession(request, response);
    if (!session) {
      return;
    }

    const deposit = await createDepositRequest(session.user.id, request.body ?? {});
    response.status(201).json({
      deposit,
      instructions: getDepositInstructions(),
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

app.get("/admin/refill-requests", (_request, response) => {
  response.type("html").send(renderRefillRequestsAdminPage());
});

app.post("/admin/refill-requests/:requestId/approve", (request, response) => {
  const requestRecord = getRefillRequest(request.params.requestId);

  if (requestRecord && requestRecord.status === "pending") {
    updateRefillRequestStatus(requestRecord, "approved");
  }

  response.redirect("/admin/refill-requests");
});

app.post("/admin/refill-requests/:requestId/reject", (request, response) => {
  const requestRecord = getRefillRequest(request.params.requestId);

  if (requestRecord && requestRecord.status === "pending") {
    updateRefillRequestStatus(requestRecord, "rejected");
  }

  response.redirect("/admin/refill-requests");
});

app.get(
  "/admin/deposits",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    response.type("html").send(renderDepositsAdminPage(await listAllDeposits()));
  }),
);

app.post(
  "/admin/deposits/:depositId/approve",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    try {
      await approveDepositRequest(request.params.depositId, actor);
    } catch (error) {
      console.error("Approve deposit failed:", error);
    }

    response.redirect("/admin/deposits");
  }),
);

app.post(
  "/admin/deposits/:depositId/reject",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request, response);
    if (!actor) {
      return;
    }

    if (!(await ensureDatabaseAccess(response))) {
      return;
    }

    try {
      await rejectDepositRequest(request.params.depositId, actor);
    } catch (error) {
      console.error("Reject deposit failed:", error);
    }

    response.redirect("/admin/deposits");
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

      response.status(403).json({
        error: "Signed-in THB balances can only be changed by approved backend deposit actions.",
      });
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
