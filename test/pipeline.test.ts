import test from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/db.ts";
import { saveCookie, saveLlmSettings } from "../src/settings.ts";
import { createQueue, estimateCost } from "../src/queue.ts";

function depsWith(overrides: Record<string, unknown> = {}) {
  const db = openDb(":memory:");
  initSchema(db);
  const { withCookie, ...rest } = overrides as { withCookie?: boolean } & Record<string, unknown>;
  if (withCookie !== false) {
    saveCookie(db, { SESSDATA: "s", bili_jct: "j", DedeUserID: "1", buvid3: "b" });
  }
  saveLlmSettings(db, { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-test-123456" });
  return {
    db,
    now: () => 1_900_000_000_000,
    workDir: "tmp/test",
    asrReady: true,
    fetchImpl: (async () => new Response("{}")) as never,
    ...rest,
  };
}

const metaResponse = (bvid = "BV1GJ411x7h7") =>
  JSON.stringify({
    code: 0,
    data: {
      bvid,
      aid: 1,
      title: "测试标题",
      owner: { name: "UP主" },
      duration: 600,
      pic: "",
      pages: [{ cid: 1, page: 1 }],
    },
  });

const llmResponse = () =>
  JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            verdict: { watch: "watch", one_line: "ok", reason: "r" },
            tldr: ["a"],
            sections: [],
            highlights: [],
            key_terms: [],
            caveats: [],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });

test("有字幕时走快路，产出报告并跳过 ASR", async () => {
  let asrCalled = 0;
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaResponse());
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//s/x.json" }] } },
        }),
      );
    if (url.includes("//s/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 5, content: "第一句话。".repeat(30) }] }));
    return new Response(llmResponse());
  };
  const deps = depsWith({
    fetchImpl: fake,
    asrRunner: async () => {
      asrCalled++;
      return [];
    },
  });
  const q = createQueue(deps);
  const jobId = await q.submit("BV1GJ411x7h7");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "done");
  assert.ok(job.reportId);
  assert.equal(asrCalled, 0);
  assert.equal(job.stage, "done");
  assert.equal(job.title, "测试标题");
});

test("字幕失败时降级到 ASR，报告标记来源", async () => {
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaResponse("BVTEST000001"));
    if (url.includes("x/player/v2")) return new Response(JSON.stringify({ code: -101, message: "未登录" }));
    if (url.includes("playurl"))
      return new Response(
        JSON.stringify({ code: 0, data: { dash: { audio: [{ baseUrl: "https://a/1.m4s", bandwidth: 1 }] } } }),
      );
    if (url.startsWith("https://a/")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response(llmResponse());
  };
  const deps = depsWith({
    withCookie: false,
    fetchImpl: fake,
    prepareAudio: async () => {},
    asrRunner: async () => [{ from: 0, to: 30, text: "语音识别出来的内容".repeat(20) }],
  });
  const q = createQueue(deps);
  const jobId = await q.submit("BVTEST000001");
  await q.onIdle();
  assert.equal(q.get(jobId)!.status, "done");
  const row = deps.db.prepare("select source from videos").get() as { source: string };
  assert.equal(row.source, "asr");
});

test("失败任务保留断点，retry 从文字稿直接重新总结（不重抓）", async () => {
  let viewCalls = 0;
  let llmCalls = 0;
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) {
      viewCalls++;
      return new Response(metaResponse("BVRETRY00001"));
    }
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//s/x.json" }] } },
        }),
      );
    if (url.includes("//s/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 5, content: "足够长的内容。".repeat(30) }] }));
    llmCalls++;
    if (llmCalls === 1) return new Response(JSON.stringify({ error: { message: "no key" } }), { status: 401 });
    return new Response(llmResponse());
  };
  const deps = depsWith({ fetchImpl: fake });
  const q = createQueue(deps);
  const jobId = await q.submit("BVRETRY00001");
  await q.onIdle();
  assert.equal(q.get(jobId)!.status, "failed");
  assert.match(q.get(jobId)!.error ?? "", /鉴权失败/);

  await q.retry(jobId);
  await q.onIdle();
  assert.equal(q.get(jobId)!.status, "done");
  assert.equal(viewCalls, 1, "重试不应重新抓元数据");
  assert.equal(q.get(jobId)!.stage, "done");
});

test("24 小时内同视频复用已有报告，不重复抓取", async () => {
  let viewCalls = 0;
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) {
      viewCalls++;
      return new Response(metaResponse("BVREUSE00001"));
    }
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//s/x.json" }] } },
        }),
      );
    if (url.includes("//s/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 5, content: "足够长的内容。".repeat(30) }] }));
    return new Response(llmResponse());
  };
  const deps = depsWith({ fetchImpl: fake });
  const q = createQueue(deps);
  const first = await q.submit("BVREUSE00001");
  await q.onIdle();
  const second = await q.submit("BVREUSE00001");
  await q.onIdle();
  assert.equal(viewCalls, 1, "第二次提交应直接复用报告");
  assert.equal(q.get(second)!.status, "done");
  assert.equal(q.get(second)!.reportId, q.get(first)!.reportId);
  assert.ok(estimateCost(3600, 12000).seconds > 0);
  assert.ok(estimateCost(3600, 12000).yuan >= 0);
});

test("非法链接的任务直接失败并给出中文原因", async () => {
  const deps = depsWith();
  const q = createQueue(deps);
  const jobId = await q.submit("https://example.com/x");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /认不出这个链接/);
});

test("缺少 ASR 组件时失败文案指向设置页", async () => {  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaResponse("BVNOASR00001"));
    if (url.includes("x/player/v2")) return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }));
    return new Response("{}");
  };
  const deps = depsWith({ fetchImpl: fake, asrReady: false });
  const q = createQueue(deps, );
  const jobId = await q.submit("BVNOASR00001");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /缺少语音识别组件/);
});

test("force 提交跳过复用，重新生成新报告", async () => {
  let viewCalls = 0;
  let llmCalls = 0;
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) {
      viewCalls++;
      return new Response(metaResponse("BVFORCE00001"));
    }
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//s/x.json" }] } },
        }),
      );
    if (url.includes("//s/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 5, content: "足够长的内容。".repeat(30) }] }));
    llmCalls++;
    return new Response(llmResponse());
  };
  const deps = depsWith({ fetchImpl: fake });
  const q = createQueue(deps);
  const first = await q.submit("BVFORCE00001");
  await q.onIdle();
  const second = await q.submit("BVFORCE00001", true);
  await q.onIdle();
  assert.equal(llmCalls, 2, "强制重新生成应再调用一次 LLM");
  assert.notEqual(q.get(second)!.reportId, q.get(first)!.reportId);
  assert.equal(viewCalls, 2);
});
