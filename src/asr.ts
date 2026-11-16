import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegStatic from "ffmpeg-static";
import type { Cue, FetchLike } from "./types.ts";
import { BILI_HEADERS, hostAllowed, MEDIA_HOST_SUFFIXES } from "./bilibili.ts";

const ffmpegPath = (typeof ffmpegStatic === "string" ? ffmpegStatic : null) as string | null;

export const ASR_TARGETS = {
  cudaCublas: "bin/whisper-cublas-12.4.0-bin-x64",
  cpu: "bin/whisper-bin-x64",
  modelMedium: "models/ggml-medium.bin",
  modelSmall: "models/ggml-small.bin",
} as const;

type PlayUrlResponse = {
  code: number;
  message?: string;
  data?: { dash?: { audio?: { baseUrl?: string; base_url?: string; bandwidth?: number }[] } };
};

export async function fetchAudioUrl(bvid: string, cid: number, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fourk=1`,
    { headers: BILI_HEADERS() },
  );
  const json = (await res.json()) as PlayUrlResponse;
  if (json.code !== 0) throw new Error(`拿音频地址失败：${json.message ?? json.code}`);

  const audio = json.data?.dash?.audio ?? [];
  const best = audio
    .filter((a) => a.baseUrl || a.base_url)
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  if (!best) throw new Error("这个视频没有可用的音频流（可能是图文或无声视频）");
  const url = (best.baseUrl ?? best.base_url) as string;
  if (!hostAllowed(url, MEDIA_HOST_SUFFIXES)) {
    throw new Error("音频地址不在 B站域名下，拒绝下载");
  }
  return url;
}

export async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: FetchLike,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const res = await fetchImpl(url, { headers: BILI_HEADERS() });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const total = Number(res.headers.get("content-length") ?? 0);
  let done = 0;

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    done += chunk.length;
    onProgress?.(done, total);
  });

  await pipeline(source, fs.createWriteStream(part));
  fs.renameSync(part, dest);
}

function binName(root: string, dir: string): string | null {
  for (const name of ["whisper-cli.exe", "main.exe"]) {
    const p = path.join(root, dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function pickWhisperBinary(root: string): string | null {
  return binName(root, ASR_TARGETS.cudaCublas) ?? binName(root, ASR_TARGETS.cpu);
}

export function pickModel(root: string): string | null {
  for (const model of [ASR_TARGETS.modelMedium, ASR_TARGETS.modelSmall]) {
    const p = path.join(root, model);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function ensureAsr(root = process.cwd()): Promise<{ ready: boolean; missing: string[] }> {
  const missing: string[] = [];
  if (!pickWhisperBinary(root)) missing.push(`${ASR_TARGETS.cudaCublas}/whisper-cli.exe（或 ${ASR_TARGETS.cpu}）`);
  if (!pickModel(root)) missing.push(ASR_TARGETS.modelMedium);
  return { ready: missing.length === 0, missing };
}

type WhisperJson = {
  transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
};

export function parseWhisperJson(json: unknown): Cue[] {
  const data = json as WhisperJson;
  const rows = data?.transcription ?? [];
  const cues: Cue[] = [];
  for (const row of rows) {
    const text = (row.text ?? "").trim();
    if (!text) continue;
    const from = (row.offsets?.from ?? 0) / 1000;
    const to = (row.offsets?.to ?? 0) / 1000;
    if (to <= from) continue;
    cues.push({ from: Number(from.toFixed(2)), to: Number(to.toFixed(2)), text });
  }
  return cues;
}

export async function transcribe(
  wavPath: string,
  opts: { binPath: string; modelPath: string; threads?: number },
): Promise<Cue[]> {
  const outBase = wavPath.replace(/\.wav$/i, "");
  const args = [
    "-m",
    opts.modelPath,
    "-f",
    wavPath,
    "-l",
    "zh",
    "-oj",
    "-of",
    outBase,
    "-ml",
    "1",
    "-mc",
    "0",
    "-t",
    String(opts.threads ?? 8),
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.binPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`语音识别失败（退出码 ${code}）：${stderr.slice(-500)}`));
    });
  });

  const jsonPath = `${outBase}.json`;
  const raw = fs.readFileSync(jsonPath, "utf8");
  fs.rmSync(jsonPath, { force: true });
  return parseWhisperJson(JSON.parse(raw));
}

export async function transcribeAuto(
  root: string,
  wavPath: string,
  run: (wavPath: string, opts: { binPath: string; modelPath: string }) => Promise<Cue[]> = transcribe,
): Promise<Cue[]> {
  const model = pickModel(root);
  if (!model) throw new Error("语音识别组件不完整，去设置里重新安装");

  const cuda = binName(root, ASR_TARGETS.cudaCublas);
  const cpu = binName(root, ASR_TARGETS.cpu);

  if (cuda) {
    try {
      return await run(wavPath, { binPath: cuda, modelPath: model });
    } catch (err) {
      if (!cpu) throw err;
    }
  }
  if (!cpu) throw new Error("语音识别组件不完整，去设置里重新安装");
  return run(wavPath, { binPath: cpu, modelPath: model });
}

export async function toWav(input: string, output: string): Promise<void> {  if (!ffmpegPath) throw new Error("ffmpeg 不可用，重新安装依赖试试");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ["-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`音频转码失败（退出码 ${code}）：${stderr.slice(-500)}`));
    });
  });
}
