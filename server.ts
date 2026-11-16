import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDb, initSchema, redactSecrets, type Settings } from "./src/db.ts";
import { loadSettings, saveLlmSettings, saveCookie, getLlmConfig } from "./src/settings.ts";
import { getCookie, checkLogin, createQr, pollQr } from "./src/auth.ts";
import { parseVideoInput } from "./src/bilibili.ts";
import { getInstallState, installAsr } from "./src/install.ts";
import { ensureAsr } from "./src/asr.ts";
import { createQueue, type Deps } from "./src/queue.ts";
import { NoSpeechContentError, renderMarkdown, type ReportPayload } from "./src/llm.ts";
import { listReports, getReport, deleteReport, getVideo, type ReportSummary } from "./src/db.ts";

export const VERSION = "0.1.0";
export const PORT = 4318;
export const HOST = "127.0.0.1";

const here = path.dirname(fileURLToPath(import.meta.url));

type AppOpts = { db?: DatabaseSync; deps?: Partial<Deps> };

function errorResponse(res: express.Response, err: unknown): void {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));
  const bili = (err as { bili?: { kind: string } }).bili;
  if (bili) {
    res.status(400).json({ error: message });
    return;
  }
  if (err instanceof NoSpeechContentError) {
    res.status(422).json({ error: message });
    return;
  }
  res.status(500).json({ error: message });
}

function summaryView(r: ReportSummary) {
  return {
    id: r.id,
    bvid: r.bvid,
    cid: r.cid,
    title: r.title,
    owner: r.owner,
    duration: r.duration,
    cover: r.cover,
    source: r.source,
    createdAt: r.createdAt,
    verdict: verdictOf(r.payloadJson),
  };
}

function verdictOf(payloadJson: string): { watch: string; one_line: string } | null {
  try {
    const p = JSON.parse(payloadJson) as Partial<ReportPayload>;
    if (p.verdict && typeof p.verdict.watch === "string") {
      return { watch: p.verdict.watch, one_line: p.verdict.one_line ?? "" };
    }
  } catch {
    // 忽略
  }
  return null;
}

export function createApp(opts: AppOpts = {}) {
  fs.mkdirSync(path.join(here, "data"), { recursive: true });
  const db = opts.db ?? openDb(path.join(here, "data", "app.db"));
  initSchema(db);

  const fetchImpl = opts.deps?.fetchImpl ?? (globalThis.fetch as Deps["fetchImpl"]);
  const queue = createQueue({
    db,
    fetchImpl,
    now: Date.now,
    workDir: path.join(here, "tmp", "work"),
    ...opts.deps,
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  // ---- 分析任务 ----
  app.post("/api/analyze", async (req, res) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      const force = Boolean(req.body?.force);
      if (!url) {
        res.status(400).json({ error: "输入是空的，粘一个 B站 链接试试" });
        return;
      }
      const parsed = parseVideoInput(url);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.reason });
        return;
      }
      const jobId = await queue.submit(url, force);
      res.json({ jobId });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json(job);
  });

  app.get("/api/jobs", (req, res) => {
    const onlyRunning = req.query.running === "1";
    const jobs = queue.list(50);
    res.json({ items: onlyRunning ? jobs.filter((j) => j.status === "queued" || j.status === "running") : jobs });
  });

  app.post("/api/jobs/:id/retry", async (req, res) => {
    try {
      await queue.retry(req.params.id);
      res.json({ jobId: req.params.id });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  // ---- 报告 ----
  app.get("/api/reports", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const offset = Number(req.query.offset ?? 0) || 0;
    res.json({ items: listReports(db, q, limit, offset).map(summaryView) });
  });

  app.get("/api/reports/:id", (req, res) => {
    const report = getReport(db, req.params.id);
    if (!report) {
      res.status(404).json({ error: "报告不存在" });
      return;
    }
    const video = getVideo(db, report.bvid, report.cid);
    let payload: ReportPayload | null = null;
    try {
      payload = JSON.parse(report.payloadJson) as ReportPayload;
    } catch {
      payload = null;
    }
    res.json({
      id: report.id,
      bvid: report.bvid,
      cid: report.cid,
      createdAt: report.createdAt,
      markdown: report.markdown,
      payload,
      degraded: payload === null,
      meta: {
        title: video?.title ?? "",
        owner: video?.owner ?? "",
        duration: video?.duration ?? 0,
        cover: video?.cover ?? "",
        source: video?.source ?? "subtitle",
        bvid: report.bvid,
      },
    });
  });

  app.delete("/api/reports/:id", (req, res) => {
    deleteReport(db, req.params.id);
    res.json({ ok: true });
  });

  // ---- 设置 ----
  app.get("/api/settings", (_req, res) => {
    res.json(loadSettings(db));
  });

  app.put("/api/settings/llm", (req, res) => {
    try {
      const { baseUrl, model, apiKey } = req.body ?? {};
      saveLlmSettings(db, { baseUrl, model, apiKey });
      res.json({ ok: true });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.post("/api/settings/llm/test", async (_req, res) => {
    try {
      const cfg = getLlmConfig(db);
      if (!cfg.apiKey) {
        res.json({ ok: false, message: "还没填 API key" });
        return;
      }
      const r = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 401 || r.status === 403) {
        res.json({ ok: false, message: "鉴权失败，请检查 API key" });
        return;
      }
      if (!r.ok) {
        res.json({ ok: false, message: `接口返回 HTTP ${r.status}，检查 base URL 和模型名` });
        return;
      }
      res.json({ ok: true, message: `连接正常（模型 ${cfg.model}）` });
    } catch (err) {
      res.json({ ok: false, message: redactSecrets(err instanceof Error ? err.message : String(err)) });
    }
  });

  // ---- 扫码登录 ----
  app.post("/api/auth/qr", async (_req, res) => {
    try {
      const qr = await createQr(fetchImpl);
      res.json({ key: qr.key, pngDataUrl: qr.pngDataUrl });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.get("/api/auth/qr/:key", async (req, res) => {
    try {
      const result = await pollQr(req.params.key, fetchImpl);
      if (result.state === "confirmed" && result.cookie) {
        saveCookie(db, result.cookie);
        const who = await checkLogin(result.cookie, fetchImpl).catch(() => ({ isLogin: true, uname: null }));
        res.json({ state: "confirmed", uname: who.uname });
        return;
      }
      res.json({ state: result.state });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.get("/api/auth/status", async (_req, res) => {
    const cookie = getCookie(db);
    if (!cookie) {
      res.json({ isLogin: false, uname: null });
      return;
    }
    try {
      res.json(await checkLogin(cookie, fetchImpl));
    } catch {
      res.json({ isLogin: false, uname: null });
    }
  });

  // ---- ASR 组件 ----
  app.get("/api/asr/status", async (_req, res) => {
    res.json(await ensureAsr());
  });

  app.get("/api/asr/install", (_req, res) => {
    res.json(getInstallState());
  });

  app.post("/api/asr/install", (_req, res) => {
    res.json({ started: true });
    void installAsr({ fetchImpl }).catch(() => {
      // 状态里已经记录了错误
    });
  });

  app.use(express.static(path.join(here, "public")));

  // hash 路由：其余路径回退到单页
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(here, "public", "index.html"), (err) => {
      if (err) next();
    });
  });

  return app;
}

const isMain = process.argv[1]
  ? import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
  : false;

if (isMain) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`报告服务已启动：http://${HOST}:${PORT}`);
    console.log("关掉这个窗口就等于关闭服务。");
  });
}

export { renderMarkdown };
export type { Settings };
