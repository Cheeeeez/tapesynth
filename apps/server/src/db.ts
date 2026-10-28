import Database from 'better-sqlite3';

export type Db = Database.Database;

export type JobStatus = 'awaiting_payment' | 'queued' | 'running' | 'done' | 'failed';

export type JobRow = {
  id: string;
  created_at: number;
  status: JobStatus;
  request_json: string;
  result_json: string | null;
  error: string | null;
  price_wei: string;
  payer: string | null;
  tx_hash: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY,
  created_at INTEGER,
  status TEXT,
  request_json TEXT,
  result_json TEXT,
  error TEXT,
  price_wei TEXT,
  payer TEXT,
  tx_hash TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS usage(
  day TEXT,
  kind TEXT,
  count INTEGER,
  PRIMARY KEY(day, kind)
);
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export type UsageKind = 'free_synth' | 'pro_job';

export function bumpUsage(db: Db, kind: UsageKind, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  db.prepare('INSERT INTO usage(day, kind, count) VALUES(?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET count = count + 1').run(day, kind);
}

export type Stats = { freeSynth: number; proJobs: number; uniquePayers: number };

export function readStats(db: Db): Stats {
  const sum = (kind: UsageKind) => (db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM usage WHERE kind = ?').get(kind) as { n: number }).n;
  const payers = db.prepare("SELECT COUNT(DISTINCT payer) AS n FROM jobs WHERE payer IS NOT NULL AND status IN ('queued','running','done')").get() as { n: number };
  return { freeSynth: sum('free_synth'), proJobs: sum('pro_job'), uniquePayers: payers.n };
}
