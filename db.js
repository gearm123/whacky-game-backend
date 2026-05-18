import { readFileSync } from "node:fs";
import { Pool } from "pg";

let pool = null;
let schemaPromise = null;

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
      "DATABASE_URL is not set. Configure DATABASE_URL, POSTGRES_URL, or DATABASE_URL_FILE to enable Postgres-backed auth and wallet storage.",
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

  await poolInstance.query(`
    create table if not exists deposit_requests (
      id text primary key,
      user_id text not null references app_users(id) on delete cascade,
      amount numeric(14, 2) not null,
      currency text not null,
      status text not null,
      sender_wallet_id text,
      transfer_reference text,
      note text,
      destination_label text not null,
      destination_account text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      approved_at timestamptz,
      rejected_at timestamptz,
      approved_by text,
      rejected_by text
    );
  `);
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
