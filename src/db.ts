import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { BiliCookie } from "./types.ts";

export type SettingsKey =
  | "llm_base_url"
  | "llm_model"
  | "llm_api_key"
  | "bili_cookie"
  | "asr_ready";

export type Settings = {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKeyMasked: string;
  biliCookie: BiliCookie | null;
};

export type VideoSource = "subtitle" | "asr";

export type VideoRow = {
  bvid: string;
  cid: number;
  title: string;
  owner: string;
  duration: number;
  cover: string;
  source: VideoSource;
  transcriptJson: string;
  transcriptText: string;
  fetchedAt: number;
};

export type ReportRow = {
  id: string;
  bvid: string;
  cid: number;
  model: string;
  promptVersion: string;
  payloadJson: string;
  markdown: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: number;
};

export type ReportSummary = ReportRow & {
  title: string;
  owner: string;
  duration: number;
  cover: string;
  source: VideoSource;
  bvid: string;
};

export type JobStatus = "queued" | "running" | "done" | "failed";

export type JobStage =
  | "parsing"
  | "fetching_meta"
  | "subtitle"
  | "downloading"
  | "transcribing"
  | "summarizing"
  | "done"
  | "failed";

export type JobRow = {
  id: string;
  url: string;
  bvid: string | null;
  cid: number | null;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  error: string | null;
  reportId: string | null;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_LLM_MODEL = "deepseek-chat";

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      bvid TEXT NOT NULL,
      cid INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 0,
      cover TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'subtitle',
      transcript_json TEXT NOT NULL DEFAULT '[]',
      transcript_text TEXT NOT NULL DEFAULT '',
      fetched_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bvid, cid)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      bvid TEXT NOT NULL,
      cid INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      prompt_version TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      markdown TEXT NOT NULL DEFAULT '',
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_reports_video ON reports (bvid, cid, created_at);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      bvid TEXT,
      cid INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'parsing',
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      report_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
}

export function getSetting(db: DatabaseSync, key: SettingsKey): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(db: DatabaseSync, key: SettingsKey, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function maskSecret(value: string): string {
  if (value.length < 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(SESSDATA=)([^;\s]+)/gi, (_m, prefix: string, value: string) => prefix + maskSecret(value))
    .replace(/(bili_jct=)([^;\s]+)/gi, (_m, prefix: string, value: string) => prefix + maskSecret(value))
    .replace(/(Bearer\s+)(\S+)/gi, (_m, prefix: string, value: string) => prefix + maskSecret(value))
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, (token) => maskSecret(token));
}

function parseCookie(raw: string | null): BiliCookie | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BiliCookie>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      SESSDATA: String(parsed.SESSDATA ?? ""),
      bili_jct: String(parsed.bili_jct ?? ""),
      DedeUserID: String(parsed.DedeUserID ?? ""),
      buvid3: String(parsed.buvid3 ?? ""),
    };
  } catch {
    return null;
  }
}

export function getSettings(db: DatabaseSync): Settings {
  return {
    llmBaseUrl: getSetting(db, "llm_base_url") ?? DEFAULT_LLM_BASE_URL,
    llmModel: getSetting(db, "llm_model") ?? DEFAULT_LLM_MODEL,
    llmApiKeyMasked: maskSecret(getSetting(db, "llm_api_key") ?? ""),
    biliCookie: parseCookie(getSetting(db, "bili_cookie")),
  };
}

export function upsertVideo(db: DatabaseSync, v: VideoRow): void {
  db.prepare(
    `INSERT INTO videos (bvid, cid, title, owner, duration, cover, source, transcript_json, transcript_text, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bvid, cid) DO UPDATE SET
       title = excluded.title, owner = excluded.owner, duration = excluded.duration,
       cover = excluded.cover, source = excluded.source, transcript_json = excluded.transcript_json,
       transcript_text = excluded.transcript_text, fetched_at = excluded.fetched_at`,
  ).run(
    v.bvid,
    v.cid,
    v.title,
    v.owner,
    v.duration,
    v.cover,
    v.source,
    v.transcriptJson,
    v.transcriptText,
    v.fetchedAt,
  );
}

type VideoDbRow = {
  bvid: string;
  cid: number;
  title: string;
  owner: string;
  duration: number;
  cover: string;
  source: string;
  transcript_json: string;
  transcript_text: string;
  fetched_at: number;
};

function toVideo(row: VideoDbRow): VideoRow {
  return {
    bvid: row.bvid,
    cid: Number(row.cid),
    title: row.title,
    owner: row.owner,
    duration: Number(row.duration),
    cover: row.cover,
    source: row.source === "asr" ? "asr" : "subtitle",
    transcriptJson: row.transcript_json,
    transcriptText: row.transcript_text,
    fetchedAt: Number(row.fetched_at),
  };
}

export function getVideo(db: DatabaseSync, bvid: string, cid: number): VideoRow | null {
  const row = db
    .prepare("SELECT * FROM videos WHERE bvid = ? AND cid = ?")
    .get(bvid, cid) as VideoDbRow | undefined;
  return row ? toVideo(row) : null;
}

export function insertReport(db: DatabaseSync, r: ReportRow): void {
  db.prepare(
    `INSERT INTO reports (id, bvid, cid, model, prompt_version, payload_json, markdown, tokens_in, tokens_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.bvid,
    r.cid,
    r.model,
    r.promptVersion,
    r.payloadJson,
    r.markdown,
    r.tokensIn,
    r.tokensOut,
    r.createdAt,
  );
}

type ReportDbRow = {
  id: string;
  bvid: string;
  cid: number;
  model: string;
  prompt_version: string;
  payload_json: string;
  markdown: string;
  tokens_in: number;
  tokens_out: number;
  created_at: number;
};

function toReport(row: ReportDbRow): ReportRow {
  return {
    id: row.id,
    bvid: row.bvid,
    cid: Number(row.cid),
    model: row.model,
    promptVersion: row.prompt_version,
    payloadJson: row.payload_json,
    markdown: row.markdown,
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    createdAt: Number(row.created_at),
  };
}

export function getReport(db: DatabaseSync, id: string): ReportRow | null {
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportDbRow | undefined;
  return row ? toReport(row) : null;
}

export function deleteReport(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM reports WHERE id = ?").run(id);
}

export function listReports(db: DatabaseSync, q: string, limit: number, offset: number): ReportSummary[] {
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT r.*, v.title AS v_title, v.owner AS v_owner, v.duration AS v_duration,
              v.cover AS v_cover, v.source AS v_source
       FROM reports r LEFT JOIN videos v ON v.bvid = r.bvid AND v.cid = r.cid
       WHERE ? = '' OR v.title LIKE ? OR v.owner LIKE ? OR r.markdown LIKE ?
       ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(q, like, like, like, limit, offset) as (ReportDbRow & {
    v_title: string | null;
    v_owner: string | null;
    v_duration: number | null;
    v_cover: string | null;
    v_source: string | null;
  })[];
  return rows.map((row) => ({
    ...toReport(row),
    title: row.v_title ?? "（视频信息已删除）",
    owner: row.v_owner ?? "",
    duration: Number(row.v_duration ?? 0),
    cover: row.v_cover ?? "",
    source: row.v_source === "asr" ? "asr" : "subtitle",
  }));
}

export function findRecentReport(
  db: DatabaseSync,
  bvid: string,
  cid: number,
  hours: number,
  now: number,
): ReportRow | null {
  const row = db
    .prepare("SELECT * FROM reports WHERE bvid = ? AND cid = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
    .get(bvid, cid, now - hours * 3600_000) as ReportDbRow | undefined;
  return row ? toReport(row) : null;
}

export function insertJob(db: DatabaseSync, j: JobRow): void {
  db.prepare(
    `INSERT INTO jobs (id, url, bvid, cid, status, stage, progress, error, report_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    j.id,
    j.url,
    j.bvid,
    j.cid,
    j.status,
    j.stage,
    j.progress,
    j.error,
    j.reportId,
    j.createdAt,
    j.updatedAt,
  );
}

export function updateJob(db: DatabaseSync, id: string, patch: Partial<JobRow>): void {
  const current = getJob(db, id);
  if (!current) return;
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE jobs SET bvid = ?, cid = ?, status = ?, stage = ?, progress = ?, error = ?,
       report_id = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.bvid,
    next.cid,
    next.status,
    next.stage,
    next.progress,
    next.error,
    next.reportId,
    next.updatedAt,
    id,
  );
}

type JobDbRow = {
  id: string;
  url: string;
  bvid: string | null;
  cid: number | null;
  status: string;
  stage: string;
  progress: number;
  error: string | null;
  report_id: string | null;
  created_at: number;
  updated_at: number;
};

function toJob(row: JobDbRow): JobRow {
  return {
    id: row.id,
    url: row.url,
    bvid: row.bvid,
    cid: row.cid === null ? null : Number(row.cid),
    status: row.status as JobStatus,
    stage: row.stage as JobStage,
    progress: Number(row.progress),
    error: row.error,
    reportId: row.report_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function getJob(db: DatabaseSync, id: string): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobDbRow | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(db: DatabaseSync, limit: number): JobRow[] {
  const rows = db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as JobDbRow[];
  return rows.map(toJob);
}
