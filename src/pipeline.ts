import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Cue, Paragraph } from "./types.ts";
import {
  findRecentReport,
  findVideoByBvidPage,
  getJob,
  getVideo,
  insertReport,
  redactSecrets,
  updateJob,
  upsertVideo,
  type JobStage,
} from "./db.ts";
import { getLlmConfig, hasLlmKey } from "./settings.ts";
import { fetchSubtitle, fetchVideoMeta, parseVideoInput, resolveShortLink, type SubtitleResult } from "./bilibili.ts";
import { cookieHeader, getCookie } from "./auth.ts";
import { cuesToParagraphs, paragraphsToTimestampedText, subtitleFitsVideo } from "./subtitle.ts";
import { summarize, renderMarkdown, PROMPT_VERSION } from "./llm.ts";
import {
  downloadFile,
  ensureAsr,
  fetchAudioUrl,
  toWav,
  transcribe,
  transcribeAuto,
} from "./asr.ts";
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

const RISK_CONTROL_BACKOFF = [300, 900, 2700];

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
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const touch = (stage: JobStage, patch: Parameters<typeof updateJob>[2] = {}) =>
    updateJob(db, jobId, {
      stage,
      progress: stageProgress(stage),
      updatedAt: deps.now(),
      ...patch,
    });

  const tempFiles: string[] = [];

  try {
    touch("parsing", { status: "running", error: null });

    const job = getJob(db, jobId);
    const cached = job?.bvid && job.cid !== null ? getVideo(db, job.bvid, job.cid) : null;
    let paragraphs = cached ? readTranscript(cached.transcriptJson) : [];
    let title = cached?.title ?? "";
    let owner = cached?.owner ?? "";
    let duration = cached?.duration ?? 0;
    let bvid = cached?.bvid ?? "";
    let page = cached?.page ?? 1;
    let subtitleFallbackNote: string | null = null;

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
      page = input.p;

      // 复用只看「同一个 bvid 的同一个分 P」，不能拿 P1 的报告冒充 P2
      if (bvid && !opts.force) {
        const cachedRow = findVideoByBvidPage(db, bvid, page);
        if (cachedRow) {
          const recent = findRecentReport(db, bvid, cachedRow.cid, 24, deps.now());
          if (recent) {
            touch("done", { status: "done", reportId: recent.id, bvid, cid: cachedRow.cid });
            return;
          }
        }
      }

      touch("fetching_meta");
      const meta = await fetchVideoMeta(inputId, page, deps.fetchImpl);
      bvid = meta.bvid;
      page = meta.page;
      title = meta.title;
      owner = meta.owner;
      duration = meta.duration;
      updateJob(db, jobId, { bvid: meta.bvid, cid: meta.cid, updatedAt: deps.now() });

      const existing = getVideo(db, meta.bvid, meta.cid);
      paragraphs = existing ? readTranscript(existing.transcriptJson) : [];

      if (paragraphs.length === 0) {
        touch("subtitle");
        const cookie = getCookie(db);
        const fetchOnce = async (): Promise<SubtitleResult> =>
          cookie
            ? fetchSubtitle(meta.bvid, meta.cid, cookieHeader(cookie), deps.fetchImpl)
            : { ok: false, reason: "not_logged_in", detail: "还没登录" };

        let sub = await fetchOnce();
        if (!sub.ok && sub.reason === "risk_control") {
          for (const wait of RISK_CONTROL_BACKOFF) {
            await sleep(wait);
            sub = await fetchOnce();
            if (sub.ok) break;
            if (sub.reason !== "risk_control") break;
          }
        }

        let cues: Cue[];
        let source: "subtitle" | "asr";
        const subtitleUsable = sub.ok && subtitleFitsVideo(sub.cues, meta.duration);

        if (sub.ok && subtitleUsable) {
          cues = sub.cues;
          source = "subtitle";
        } else {
          const reason = sub.ok ? "mismatch" : sub.reason;
          subtitleFallbackNote =
            reason === "mismatch"
              ? "B站给这个视频挂的字幕和视频时长对不上（疑似复用了别的视频的字幕），下面的文字来自本机语音识别，可能有错。"
              : reason === "not_logged_in"
                ? "字幕没拿到（登录过期或未登录），下面的文字来自本机语音识别，可能有错。"
                : reason === "risk_control"
                  ? "B站限流，字幕暂时拿不到，下面的文字来自本机语音识别，可能有错。"
                  : "这个视频没有字幕，下面的文字来自本机语音识别，可能有错。";

          const ready = deps.asrReady ?? (await ensureAsr()).ready;
          if (!ready) {
            throw new Error(
              reason === "mismatch"
                ? "这个视频的字幕和时长对不上（B站挂错了字幕），不敢拿来总结；本机语音识别组件也没装，装好后可以重试"
                : reason === "not_logged_in"
                  ? "登录过期或没登录，去设置里扫码；本机语音识别组件也没装，装好后没字幕的视频也能处理"
                  : "缺少语音识别组件（约 1.5GB），去设置里一键安装，装好后点重试",
            );
          }

          touch("downloading");
          const audioUrl = await fetchAudioUrl(meta.bvid, meta.cid, deps.fetchImpl);
          fs.mkdirSync(deps.workDir, { recursive: true });
          const audioPath = path.join(deps.workDir, `${meta.bvid}-${meta.cid}.m4a`);
          const wavPath = path.join(deps.workDir, `${meta.bvid}-${meta.cid}.wav`);
          tempFiles.push(audioPath, wavPath);

          await downloadFile(audioUrl, audioPath, deps.fetchImpl);
          if (deps.prepareAudio) await deps.prepareAudio(audioPath, wavPath);
          else await toWav(audioPath, wavPath);

          touch("transcribing");
          if (deps.asrRunner) {
            cues = await deps.asrRunner(wavPath);
          } else {
            cues = await transcribeAuto(process.cwd(), wavPath, transcribe);
          }
          source = "asr";
        }

        paragraphs = cuesToParagraphs(cues);
        if (paragraphs.length === 0) throw new Error("这个视频没有识别出任何说话内容");

        upsertVideo(db, {
          bvid: meta.bvid,
          cid: meta.cid,
          page: meta.page,
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

    if (subtitleFallbackNote) {
      result.payload.caveats = [subtitleFallbackNote, ...result.payload.caveats];
    }

    const markdown = renderMarkdown(result.payload, { title, owner, duration, bvid, page });
    const reportId = randomUUID();
    insertReport(db, {
      id: reportId,
      bvid,
      cid: Number(getJob(db, jobId)?.cid ?? 0),
      page,
      model: getLlmConfig(db).model,
      promptVersion: PROMPT_VERSION,
      payloadJson: JSON.stringify(result.payload),
      markdown,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      degraded: result.degraded,
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
  } finally {
    for (const file of tempFiles) {
      fs.rmSync(file, { force: true });
    }
  }
}
