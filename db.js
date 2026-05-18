import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

let pool = null;
let schemaPromise = null;

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derivedKey}`;
}

function optionalEnv(key) {
  return String(process.env[key] ?? "").trim();
}

function normalizeDatabaseUrl(url) {
  const trimmed = url.trim();
  if (trimmed.startsWith("postgres://")) {
    return "postgresql://" + trimmed.slice("postgres://".length);
  }
  return trimmed;
}

function rawDatabaseUrlFromEnvironment() {
  for (const key of ["DATABASE_URL", "POSTGRES_URL"]) {
    const value = optionalEnv(key).replace(/^\uFEFF/, "");
    if (value) {
      return value;
    }
  }

  const path = optionalEnv("DATABASE_URL_FILE");
  if (path) {
    try {
      const firstLine = (readFileSync(path, "utf8").split(/\r?\n/, 1)[0] || "")
        .trim()
        .replace(/^\uFEFF/, "");
      if (firstLine) {
        return firstLine;
      }
    } catch {
      return "";
    }
  }

  return "";
}

export function isDatabaseUrlConfigured() {
  return rawDatabaseUrlFromEnvironment().length > 0;
}

export function getDatabaseUrl() {
  const raw = rawDatabaseUrlFromEnvironment();
  if (!raw) {
    throw new Error(
      "DATABASE_URL is not set. Configure DATABASE_URL, POSTGRES_URL, or DATABASE_URL_FILE to enable Postgres-backed auth and signed-in user balances.",
    );
  }
  return normalizeDatabaseUrl(raw);
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export async function pingDatabase() {
  if (!isDatabaseUrlConfigured()) {
    return false;
  }

  try {
    const client = await getPool().connect();
    try {
      await client.query("select 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

async function createSchema() {
  const poolInstance = getPool();

  await poolInstance.query(`
    create table if not exists app_users (
      id text primary key,
      username text not null,
      username_normalized text not null unique,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
  `);

  await poolInstance.query(`
    create table if not exists app_sessions (
      id text primary key,
      user_id text not null references app_users(id) on delete cascade,
      token_hash text not null unique,
      created_at timestamptz not null default now(),
      last_used_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
  `);

  await poolInstance.query(`
    create table if not exists app_wallets (
      user_id text primary key references app_users(id) on delete cascade,
      currency text not null,
      balance numeric(14, 2) not null default 0,
      updated_at timestamptz not null default now()
    );
  `);

  await poolInstance.query(`
    create table if not exists app_wallet_ledger (
      id text primary key,
      user_id text not null references app_users(id) on delete cascade,
      entry_type text not null,
      amount numeric(14, 2) not null,
      currency text not null,
      balance_after numeric(14, 2) not null,
      reference_id text,
      note text,
      created_at timestamptz not null default now()
    );
  `);

  const defaultUserId = "default-gearm-user";
  const defaultPasswordHash = hashPassword("patty");

  await poolInstance.query(
    `
      insert into app_users (id, username, username_normalized, password_hash)
      values ($1, 'gearm', 'gearm', $2)
      on conflict (username_normalized) do nothing
    `,
    [defaultUserId, defaultPasswordHash],
  );

  const defaultUserResult = await poolInstance.query(
    `
      select id
      from app_users
      where username_normalized = 'gearm'
      limit 1
    `,
  );
  const resolvedDefaultUserId = defaultUserResult.rows[0]?.id;

  if (!resolvedDefaultUserId) {
    throw new Error("Could not resolve the default gearm user after schema bootstrap.");
  }

  await poolInstance.query(
    `
      insert into app_wallets (user_id, currency, balance, updated_at)
      values ($1, 'USER_COINS', 1000000000, now())
      on conflict (user_id) do nothing
    `,
    [resolvedDefaultUserId],
  );

  await poolInstance.query(
    `
      insert into app_wallet_ledger (id, user_id, entry_type, amount, currency, balance_after, reference_id, note)
      values ($1, $2, 'seed_default_user', 1000000000, 'USER_COINS', 1000000000, null, 'Seeded default gearm user.')
      on conflict (id) do nothing
    `,
    ["seed-default-gearm-ledger", resolvedDefaultUserId],
  );
}

export async function ensureDatabaseSchema() {
  if (!isDatabaseUrlConfigured()) {
    return false;
  }

  if (!schemaPromise) {
    schemaPromise = createSchema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
  return true;
}
