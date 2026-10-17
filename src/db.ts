import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });

export const db = new Database(process.env.DB_PATH || "data/gandiva.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('data','inference','scraping')),
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  price TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  output_schema TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT 'gandiva',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verification TEXT NOT NULL DEFAULT 'unchecked',
  verification_note TEXT NOT NULL DEFAULT '',
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  run_id TEXT,
  buyer TEXT NOT NULL,
  seller TEXT NOT NULL,
  service_id TEXT,
  service_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  listed TEXT NOT NULL,
  asked TEXT,
  paid TEXT NOT NULL DEFAULT '0',
  tx_hash TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  auth_from TEXT,
  auth_nonce TEXT,
  valid_before INTEGER,
  signed_at INTEGER
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  seller TEXT NOT NULL,
  payer TEXT,
  amount TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nonces (
  key TEXT PRIMARY KEY,
  seller TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  task TEXT NOT NULL,
  budget TEXT NOT NULL,
  result TEXT
);

-- Sell-tab "LLM agent" listings: the seller's model settings. The API key is stored encrypted (see src/crypto/secrets.ts).
CREATE TABLE IF NOT EXISTS hosted_sellers (
  service_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  host TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  api_key_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sell-tab "agent chain" listings: the fixed steps (which sellers to hire, in order, and where each input comes from).
CREATE TABLE IF NOT EXISTS chain_sellers (
  service_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  sub_budget TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Money the user took back out of their agent wallet (outgoing transfers that are not payments to sellers; reconcile subtracts them).
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  auth_nonce TEXT,
  valid_before INTEGER,
  signed_at INTEGER
);

-- Wallet sign-in: one-time nonces, sessions (only a hash of the cookie token is stored) and the signed-in users.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  agent_address TEXT,
  agent_key_enc TEXT,
  llm_host TEXT,
  llm_model TEXT,
  llm_key_enc TEXT
);
`);

// Migrate databases created before listings were probed: add the verification columns.
const serviceColumns = (db.prepare("PRAGMA table_info(services)").all() as { name: string }[]).map((c) => c.name);
if (!serviceColumns.includes("verification")) {
  db.exec(`
    ALTER TABLE services ADD COLUMN verification TEXT NOT NULL DEFAULT 'unchecked';
    ALTER TABLE services ADD COLUMN verification_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE services ADD COLUMN verified_at TEXT;
  `);
}

// Migrate users created before they could bring their own planner LLM (Ollama) key.
const userColumns = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
if (!userColumns.includes("llm_key_enc")) {
  db.exec(`
    ALTER TABLE users ADD COLUMN llm_host TEXT;
    ALTER TABLE users ADD COLUMN llm_model TEXT;
    ALTER TABLE users ADD COLUMN llm_key_enc TEXT;
  `);
}

// Migrate withdrawals made before their authorisation was kept (needed to settle an "unknown" one from the chain).
const withdrawalColumns = (db.prepare("PRAGMA table_info(withdrawals)").all() as { name: string }[]).map((c) => c.name);
if (!withdrawalColumns.includes("auth_nonce")) {
  db.exec(`
    ALTER TABLE withdrawals ADD COLUMN auth_nonce TEXT;
    ALTER TABLE withdrawals ADD COLUMN valid_before INTEGER;
    ALTER TABLE withdrawals ADD COLUMN signed_at INTEGER;
  `);
}

// Migrate databases created before the "unconfirmed" status: drop the old status CHECK and add the authorisation columns.
const ledgerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ledger'").get() as { sql: string }).sql;
if (/CHECK\s*\(status IN/i.test(ledgerSql)) {
  db.exec(`
    BEGIN;
    ALTER TABLE ledger RENAME TO ledger_old;
    CREATE TABLE ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, run_id TEXT, buyer TEXT NOT NULL, seller TEXT NOT NULL,
      service_id TEXT, service_name TEXT NOT NULL, endpoint TEXT NOT NULL, listed TEXT NOT NULL, asked TEXT,
      paid TEXT NOT NULL DEFAULT '0', tx_hash TEXT, status TEXT NOT NULL, reason TEXT, latency_ms INTEGER NOT NULL DEFAULT 0,
      auth_from TEXT, auth_nonce TEXT, valid_before INTEGER, signed_at INTEGER
    );
    INSERT INTO ledger (id,ts,run_id,buyer,seller,service_id,service_name,endpoint,listed,asked,paid,tx_hash,status,reason,latency_ms)
      SELECT id,ts,run_id,buyer,seller,service_id,service_name,endpoint,listed,asked,paid,tx_hash,status,reason,latency_ms FROM ledger_old;
    DROP TABLE ledger_old;
    COMMIT;
  `);
}
