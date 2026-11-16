import test from "node:test";
import assert from "node:assert/strict";
import { fetchAudioUrl, parseWhisperJson, ensureAsr, pickWhisperBinary } from "../src/asr.ts";
import { installAsr, getInstallState } from "../src/install.ts";
import fs from "node:fs";
import path from "node:path";

test("选最高码率的音频流，并要求带 Referer", async () => {
  let seenHeaders: Record<string, string> = {};
  const fake = async (_u: string, init?: RequestInit) => {
    seenHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          dash: {
            audio: [
              { id: 30216, baseUrl: "https://a/1.m4s", bandwidth: 43962 },
              { id: 30280, baseUrl: "https://a/3.m4s", bandwidth: 203786 },
            ],
          },
        },
      }),
    );
  };
  assert.equal(await fetchAudioUrl("BV1", 1, fake as never), "https://a/3.m4s");
  assert.equal(seenHeaders.Referer, "https://www.bilibili.com/");
});

test("无音频流给出明确错误", async () => {
  const fake = async () => new Response(JSON.stringify({ code: 0, data: { dash: { audio: [] } } }));
  await assert.rejects(fetchAudioUrl("BV1", 1, fake as never), /没有可用的音频流/);
});

test("whisper JSON 转成 Cue，毫秒转秒且过滤空段", () => {
  const cues = parseWhisperJson({
    transcription: [
      { offsets: { from: 1000, to: 3000 }, text: "你好" },
      { offsets: { from: 3000, to: 4000 }, text: " " },
      { offsets: { from: 5600, to: 9000 }, text: " 第二句 " },
    ],
  });
  assert.deepEqual(cues, [
    { from: 1, to: 3, text: "你好" },
    { from: 5.6, to: 9, text: "第二句" },
  ]);
});

test("组件缺失时 ready=false 并列出缺什么", async () => {
  const r = await ensureAsr(path.join("tmp", "definitely-missing"));
  assert.equal(r.ready, false);
  assert.ok(r.missing.length >= 2);
});

test("二进制优先级：CUDA 存在优先，其次 CPU，都没有返回 null", () => {  const root = path.join("tmp", "asr-probe");
  fs.mkdirSync(path.join(root, "bin", "whisper-cublas-12.4.0-bin-x64"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "whisper-cublas-12.4.0-bin-x64", "whisper-cli.exe"), "");
  assert.match(pickWhisperBinary(root) ?? "", /whisper-cublas/);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(pickWhisperBinary(path.join("tmp", "nope")), null);
});

test("组件已存在时安装直接返回，不发任何请求", async () => {
  const root = path.join("tmp", "asr-installed");
  fs.mkdirSync(path.join(root, "bin", "whisper-cublas-12.4.0-bin-x64"), { recursive: true });
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "whisper-cublas-12.4.0-bin-x64", "whisper-cli.exe"), "");
  fs.writeFileSync(path.join(root, "models", "ggml-medium.bin"), "");
  fs.writeFileSync(path.join(root, "models", "ggml-small.bin"), "");
  let calls = 0;
  await installAsr({ root, fetchImpl: (async () => { calls++; return new Response(""); }) as never });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(calls, 0);
  assert.equal(getInstallState().running, false);
});

test("下载失败会重试并在状态里留下可读错误", async () => {
  const root = path.join("tmp", "asr-failing");
  let calls = 0;
  const fake = async () => {
    calls++;
    return new Response("nope", { status: 404 });
  };
  await assert.rejects(installAsr({ root, fetchImpl: fake as never, retries: 1 }));
  fs.rmSync(root, { recursive: true, force: true });
  assert.ok(calls >= 1);
  assert.match(getInstallState().error ?? "", /下载失败/);
});
