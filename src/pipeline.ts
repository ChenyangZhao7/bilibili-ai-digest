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
import { fetchBestSubtitle, fetchVideoMeta, parseVideoInput, resolveShortLink } from "./bilibili.ts";
import { cookieHeader, getCookie } from "./auth.ts";
import {
  cuesToParagraphs,
  paragraphsToTimestampedText,
  titleLooksUnrelated,
} from "./subtitle.ts";
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
      paragraphs = existing && !opts.force ? readTranscript(existing.transcriptJson) : [];

      if (paragraphs.length === 0) {
        touch("subtitle");
        const cookie = getCookie(db);
        const pick = await fetchBestSubtitle({
          bvid: meta.bvid,
          cid: meta.cid,
          cookie: cookie ? cookieHeader(cookie) : null,
          duration: meta.duration,
          title: meta.title,
          fetchImpl: deps.fetchImpl,
          sleep,
          attempts: deps.subtitleAttempts,
        });

        let cues: Cue[];
        let source: "subtitle" | "asr";

        if (pick.ok) {
          cues = pick.cues;
          source = "subtitle";
          if (pick.titleScore === 0) {
            subtitleFallbackNote =
              "B站返回的字幕和视频标题对不上（可能抓错了字幕，也可能标题党），这份报告基于其中一份候选字幕，建议核对。";
          }
        } else {
          const reason = pick.reason;
          subtitleFallbackNote =
            reason === "unreliable"
              ? "B站返回的字幕和视频对不上（拿到了别的视频的字幕或广告），下面的文字来自本机语音识别，可能有错。"
              : reason === "not_logged_in"
                ? "字幕没拿到（登录过期或未登录），下面的文字来自本机语音识别，可能有错。"
                : reason === "risk_control"
                  ? "B站限流，字幕暂时拿不到，下面的文字来自本机语音识别，可能有错。"
                  : "这个视频没有字幕，下面的文字来自本机语音识别，可能有错。";

          const ready = deps.asrReady ?? (await ensureAsr()).ready;
          if (!ready) {
            throw new Error(
              reason === "unreliable"
                ? "B站返回的字幕和视频对不上（拿到了别的视频的字幕或广告），不敢拿来总结；本机语音识别组件也没装，装好后可以重试"
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

    const titleUnrelated =
      paragraphs.length > 0 && titleLooksUnrelated(title, paragraphsToTimestampedText(paragraphs));

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
    if (titleUnrelated) {
      result.payload.caveats = [
        ...result.payload.caveats,
        "标题和文字稿几乎对不上：可能抓错了字幕，也可能是标题党。建议点开原片核对一眼。",
      ];
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
