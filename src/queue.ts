import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Cue, FetchLike } from "./types.ts";
import {
  findRecentReport,
  getJob,
  getVideo,
  insertJob,
  listJobs,
  updateJob,
  type JobRow,
  type JobStage,
} from "./db.ts";
import { runPipeline } from "./pipeline.ts";

export type Deps = {
  db: DatabaseSync;
  fetchImpl: FetchLike;
  now: () => number;
  asrRunner?: (wavPath: string) => Promise<Cue[]>;
  prepareAudio?: (input: string, output: string) => Promise<void>;
  asrReady?: boolean;
  sleep?: (ms: number) => Promise<void>;
  subtitleAttempts?: number;
  workDir: string;
};

export type JobView = {
  id: string;
  status: string;
  stage: string;
  progress: number;
  error: string | null;
  reportId: string | null;
  title: string | null;
  url: string;
};

function toView(db: DatabaseSync, row: JobRow): JobView {
  const video = row.bvid && row.cid !== null ? getVideo(db, row.bvid, row.cid) : null;
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    error: row.error,
    reportId: row.reportId,
    title: video?.title ?? null,
    url: row.url,
  };
}

export function estimateCost(durationSec: number, chars: number): { seconds: number; yuan: number } {
  const tokensIn = Math.ceil(chars / 3);
  const tokensOut = 2000;
  const seconds = Math.ceil(durationSec * 0.15);
  const yuan = Number(((tokensIn / 1e6) * 2 + (tokensOut / 1e6) * 8).toFixed(2));
  return { seconds, yuan };
}

export function createQueue(deps: Deps, opts: { force?: boolean } = {}) {
  const pending: string[] = [];
  const forceJobs = new Set<string>();
  let running = false;
  let idleResolvers: (() => void)[] = [];

  const resolveIdleIfDone = () => {
    if (!running && pending.length === 0) {
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const r of resolvers) r();
    }
  };

  async function pump(): Promise<void> {
    if (running) return;
    const next = pending.shift();
    if (!next) {
      resolveIdleIfDone();
      return;
    }
    running = true;
    try {
      await runPipeline(deps, next, getJob(deps.db, next)?.url ?? "", { force: forceJobs.has(next) });
    } catch {
      // runPipeline 已把错误写进任务记录
    } finally {
      forceJobs.delete(next);
      running = false;
      void pump();
      resolveIdleIfDone();
    }
  }

  function enqueue(url: string): string {
    const id = randomUUID();
    const now = deps.now();
    insertJob(deps.db, {
      id,
      url,
      bvid: null,
      cid: null,
      status: "queued",
      stage: "parsing",
      progress: 0,
      error: null,
      reportId: null,
      createdAt: now,
      updatedAt: now,
    });
    pending.push(id);
    return id;
  }

  return {
    async submit(rawUrl: string, force = opts.force ?? false): Promise<string> {
      const id = enqueue(rawUrl);
      if (force) forceJobs.add(id);
      void pump();
      return id;
    },
    async retry(jobId: string): Promise<void> {
      const job = getJob(deps.db, jobId);
      if (!job) throw new Error("任务不存在");
      updateJob(deps.db, jobId, {
        status: "queued",
        error: null,
        progress: 0,
        updatedAt: deps.now(),
      });
      if (!pending.includes(jobId)) pending.push(jobId);
      void pump();
    },
    get(jobId: string): JobView | null {
      const row = getJob(deps.db, jobId);
      return row ? toView(deps.db, row) : null;
    },
    list(limit: number): JobView[] {
      return listJobs(deps.db, limit).map((row) => toView(deps.db, row));
    },
    onIdle(): Promise<void> {
      if (!running && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
