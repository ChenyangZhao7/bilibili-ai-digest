import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FetchLike } from "./types.ts";
import { ASR_TARGETS, ensureAsr, downloadFile } from "./asr.ts";

export type InstallState = {
  running: boolean;
  stage: string;
  done: number;
  total: number;
  error: string | null;
};

const state: InstallState = { running: false, stage: "", done: 0, total: 0, error: null };

export function getInstallState(): InstallState {
  return { ...state };
}

export const ASR_DOWNLOADS = [
  {
    kind: "zip" as const,
    name: "Whisper 程序（CUDA 版）",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-cublas-12.4.0-bin-x64.zip",
    file: "downloads/whisper-cublas-12.4.0-bin-x64.zip",
    extractTo: ASR_TARGETS.cudaCublas,
  },
  {
    kind: "model" as const,
    name: "语音模型 medium（约 1.5GB）",
    url: "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    file: ASR_TARGETS.modelMedium,
  },
  {
    kind: "model" as const,
    name: "语音模型 small（约 470MB，保底）",
    url: "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    file: ASR_TARGETS.modelSmall,
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  fs.mkdirSync(targetDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${targetDir}' -Force`],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压失败：${stderr.slice(-300)}，可以手动把 zip 解压到 ${targetDir}`));
    });
  });
}

export async function installAsr(opts: {
  root?: string;
  fetchImpl: FetchLike;
  retries?: number;
  onProgress?: (p: { stage: string; done: number; total: number }) => void;
}): Promise<void> {
  const root = opts.root ?? process.cwd();
  const retries = opts.retries ?? 3;
  const report = opts.onProgress ?? (() => {});

  const already = await ensureAsr(root);
  if (already.ready) return;

  state.running = true;
  state.error = null;
  state.stage = "准备中";
  state.done = 0;
  state.total = 0;

  try {
    for (const item of ASR_DOWNLOADS) {
      const filePath = path.join(root, item.file);
      const skipFile = item.kind === "model" && fs.existsSync(filePath);
      const skipZip = item.kind === "zip" && fs.existsSync(filePath) && fs.existsSync(path.join(root, item.extractTo));
      if (skipFile || skipZip) continue;

      state.stage = `下载 ${item.name}`;
      report({ stage: state.stage, done: 0, total: 0 });

      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await downloadFile(item.url, filePath, opts.fetchImpl, (done, total) => {
            state.done = done;
            state.total = total;
            report({ stage: state.stage, done, total });
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < retries) await sleep([2000, 5000, 10000][attempt] ?? 10000);
        }
      }
      if (lastError) {
        throw new Error(
          `下载失败：${item.name}（${lastError.message}）。可以把文件手动放到 ${item.file} 再点一次安装`,
        );
      }

      if (item.kind === "zip") {
        state.stage = "解压程序";
        report({ stage: state.stage, done: 0, total: 0 });
        await extractZip(filePath, path.join(root, item.extractTo));
      }
    }

    const after = await ensureAsr(root);
    if (!after.ready) {
      throw new Error(`安装后仍缺少：${after.missing.join("、")}`);
    }
    state.stage = "完成";
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    state.running = false;
  }
}
