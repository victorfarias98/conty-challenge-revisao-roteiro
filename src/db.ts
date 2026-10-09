import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_review', 'changes_requested', 'approved')),
  approved_version INTEGER,
  approved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS script_versions (
  script_id TEXT NOT NULL REFERENCES scripts (id),
  number INTEGER NOT NULL,
  content TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (script_id, number)
);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts (id),
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  due_date TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
