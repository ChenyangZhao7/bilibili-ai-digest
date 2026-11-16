import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Cue, Paragraph } from "./types.ts";
import {
  getJob,
  getSetting,
  getVideo,
  insertReport,
  redactSecrets,
  updateJob,
  upsertVideo,
  findRecentReport,
  type JobStage,
} from "./db.ts";
import { getLlmConfig, hasLlmKey } from "./settings.ts";
import { fetchSubtitle, fetchVideoMeta, parseVideoInput, resolveShortLink } from "./bilibili.ts";
import { cookieHeader, getCookie } from "./auth.ts";
import { cuesToParagraphs, paragraphsToTimestampedText } from "./subtitle.ts";
import { summarize, renderMarkdown, PROMPT_VERSION } from "./llm.ts";
import { downloadFile, ensureAsr, fetchAudioUrl, pickModel, pickWhisperBinary, toWav, transcribe } from "./asr.ts";
import type { Deps } from "./queue.ts";

export function stageProgress(stage: JobStage): number {
  const map: Record<JobStage, number> = {
    parsing: 5,
    fetching_meta: 15,
    subtitle: 35,
    downloading: 50,
    transcribing: 80,
    summarizing: 90,
    done: 100,
    failed: 0,
  };
  return map[stage];
}

function readTranscript(raw: string): Paragraph[] {
  if (!raw || raw === "[]") return [];
  try {
    const parsed = JSON.parse(raw) as Paragraph[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p) =>
        p &&
        typeof p.text === "string" &&
        typeof p.start === "number" &&
        typeof p.end === "number",
    );
  } catch {
    return [];
  }
}

export async function runPipeline(
  deps: Deps,
  jobId: string,
  rawUrl: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const db = deps.db;
  const touch = (stage: JobStage, patch: Parameters<typeof updateJob>[2] = {}) =>
    updateJob(db, jobId, {
      stage,
      progress: stageProgress(stage),
      updatedAt: deps.now(),
      ...patch,
    });

  try {
    touch("parsing", { status: "running", error: null });

    const job = getJob(db, jobId);
    const cached = job?.bvid && job.cid !== null ? getVideo(db, job.bvid, job.cid) : null;
    let paragraphs = cached ? readTranscript(cached.transcriptJson) : [];
    let title = cached?.title ?? "";
    let owner = cached?.owner ?? "";
    let duration = cached?.duration ?? 0;
    let bvid = cached?.bvid ?? "";

    if (paragraphs.length === 0) {
      let input = parseVideoInput(rawUrl);
      if (!input.ok) throw new Error(input.reason);

      if (input.kind === "short") {
        const resolved = await resolveShortLink(input.id, deps.fetchImpl);
        input = parseVideoInput(resolved);
        if (!input.ok) throw new Error(input.reason);
        if (input.kind === "short") throw new Error("短链接跳转后仍然认不出来，直接粘视频页地址试试");
      }
      const inputId = input.id;
      bvid = input.kind === "bvid" ? inputId : "";

      if (bvid && !opts.force) {
        const cachedRow = db
          .prepare("SELECT cid FROM videos WHERE bvid = ? ORDER BY fetched_at DESC LIMIT 1")
          .get(bvid) as { cid: number } | undefined;
        if (cachedRow) {
          const recent = findRecentReport(db, bvid, Number(cachedRow.cid), 24, deps.now());
          if (recent) {
            touch("done", { status: "done", reportId: recent.id, bvid, cid: Number(cachedRow.cid) });
            return;
          }
        }
      }

      touch("fetching_meta");
      const meta = await fetchVideoMeta(inputId, input.p, deps.fetchImpl);
      bvid = meta.bvid;
      title = meta.title;
      owner = meta.owner;
      duration = meta.duration;
      updateJob(db, jobId, { bvid: meta.bvid, cid: meta.cid, updatedAt: deps.now() });

      const existing = getVideo(db, meta.bvid, meta.cid);
      paragraphs = existing ? readTranscript(existing.transcriptJson) : [];

      if (paragraphs.length === 0) {
        touch("subtitle");
        const cookie = getCookie(db);
        const sub = cookie
          ? await fetchSubtitle(meta.bvid, meta.cid, cookieHeader(cookie), deps.fetchImpl)
          : ({ ok: false as const, reason: "not_logged_in" as const, detail: "还没登录" });

        let cues: Cue[];
        let source: "subtitle" | "asr";

        if (sub.ok) {
          cues = sub.cues;
          source = "subtitle";
        } else {
          const ready = deps.asrReady ?? (await ensureAsr()).ready;
          if (!ready) {
            throw new Error("缺少语音识别组件（约 1.5GB），去设置里一键安装，装好后点重试");
          }

          touch("downloading");
          const audioUrl = await fetchAudioUrl(meta.bvid, meta.cid, deps.fetchImpl);
          fs.mkdirSync(deps.workDir, { recursive: true });
          const audioPath = path.join(deps.workDir, `${meta.bvid}-${meta.cid}.m4a`);
          const wavPath = path.join(deps.workDir, `${meta.bvid}-${meta.cid}.wav`);
          await downloadFile(audioUrl, audioPath, deps.fetchImpl);
          if (deps.prepareAudio) await deps.prepareAudio(audioPath, wavPath);
          else await toWav(audioPath, wavPath);

          touch("transcribing");
          if (deps.asrRunner) {
            cues = await deps.asrRunner(wavPath);
          } else {
            const root = process.cwd();
            const binPath = pickWhisperBinary(root);
            const modelPath = pickModel(root);
            if (!binPath || !modelPath) throw new Error("语音识别组件不完整，去设置里重新安装");
            cues = await transcribe(wavPath, { binPath, modelPath });
          }
          source = "asr";
        }

        paragraphs = cuesToParagraphs(cues);
        if (paragraphs.length === 0) throw new Error("这个视频没有识别出任何说话内容");

        upsertVideo(db, {
          bvid: meta.bvid,
          cid: meta.cid,
          title: meta.title,
          owner: meta.owner,
          duration: meta.duration,
          cover: meta.cover,
          source,
          transcriptJson: JSON.stringify(paragraphs),
          transcriptText: paragraphsToTimestampedText(paragraphs),
          fetchedAt: deps.now(),
        });
      }
    }

    if (!hasLlmKey(db)) {
      throw new Error("还没填 LLM key，文字稿已经保存好了，填好后点重试即可，不用重新抓");
    }

    touch("summarizing");
    const result = await summarize({
      cfg: getLlmConfig(db),
      meta: { title, owner, duration },
      paragraphs,
      fetchImpl: deps.fetchImpl,
    });

    const markdown = renderMarkdown(result.payload, { title, owner, duration, bvid });
    const reportId = randomUUID();
    insertReport(db, {
      id: reportId,
      bvid,
      cid: Number(getJob(db, jobId)?.cid ?? 0),
      model: getLlmConfig(db).model,
      promptVersion: PROMPT_VERSION,
      payloadJson: JSON.stringify(result.payload),
      markdown,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      createdAt: deps.now(),
    });

    touch("done", { status: "done", reportId, error: null });
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    updateJob(db, jobId, {
      status: "failed",
      stage: "failed",
      progress: 0,
      error: message,
      updatedAt: deps.now(),
    });
    throw err;
  }
}
