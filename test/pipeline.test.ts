import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
      pages: [{ cid: 1, page: 1, duration: 300 }],
    },
  });

const multiMetaResponse = (bvid = "BVMULTI00001") =>
  JSON.stringify({
    code: 0,
    data: {
      bvid,
      aid: 2,
      title: "多P视频",
      owner: { name: "UP主" },
      duration: 900,
      pic: "",
      pages: [
        { cid: 11, page: 1, duration: 600 },
        { cid: 22, page: 2, duration: 300 },
      ],
    },
  });

const shortMetaResponse = (bvid: string, duration: number) =>
  JSON.stringify({
    code: 0,
    data: {
      bvid,
      aid: 3,
      title: "短视频",
      owner: { name: "UP主" },
      duration,
      pic: "",
      pages: [{ cid: 31, page: 1, duration }],
    },
  });

const metaWithTitle = (bvid: string, title: string, duration = 600) =>
  JSON.stringify({
    code: 0,
    data: {
      bvid,
      aid: 5,
      title,
      owner: { name: "UP主" },
      duration,
      pic: "",
      pages: [{ cid: 51, page: 1, duration }],
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
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: "第一句话。".repeat(30) }, { from: 60, to: 120, content: "第一句话。".repeat(30) }, { from: 120, to: 180, content: "第一句话。".repeat(30) }] }));
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
        JSON.stringify({ code: 0, data: { dash: { audio: [{ baseUrl: "https://a.bilivideo.com/1.m4s", bandwidth: 1 }] } } }),
      );
    if (url.startsWith("https://a.bilivideo.com/")) return new Response(new Uint8Array([1, 2, 3]));
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
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: "足够长的内容。".repeat(30) }, { from: 60, to: 120, content: "足够长的内容。".repeat(30) }, { from: 120, to: 180, content: "足够长的内容。".repeat(30) }] }));
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
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: "足够长的内容。".repeat(30) }, { from: 60, to: 120, content: "足够长的内容。".repeat(30) }, { from: 120, to: 180, content: "足够长的内容。".repeat(30) }] }));
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

test("缺少 ASR 组件时失败文案指向设置页", async () => {
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaResponse("BVNOASR00001"));
    if (url.includes("x/player/v2")) return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }));
    return new Response("{}");
  };
  const deps = depsWith({ fetchImpl: fake, asrReady: false });
  const q = createQueue(deps);
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
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: "足够长的内容。".repeat(30) }, { from: 60, to: 120, content: "足够长的内容。".repeat(30) }, { from: 120, to: 180, content: "足够长的内容。".repeat(30) }] }));
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

test("缓存了 P1 也不能拿来冒充 P2", async () => {
  let viewCalls = 0;
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) {
      viewCalls++;
      return new Response(multiMetaResponse());
    }
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: "足够长的内容。".repeat(30) }, { from: 60, to: 120, content: "足够长的内容。".repeat(30) }, { from: 120, to: 180, content: "足够长的内容。".repeat(30) }] }));
    return new Response(llmResponse());
  };
  const deps = depsWith({ fetchImpl: fake });
  const q = createQueue(deps);
  const p1 = await q.submit("BVMULTI00001");
  await q.onIdle();
  const p2 = await q.submit("https://www.bilibili.com/video/BVMULTI00001/?p=2");
  await q.onIdle();

  assert.equal(viewCalls, 2, "请求 P2 时必须重新解析元数据");
  assert.notEqual(q.get(p2)!.reportId, q.get(p1)!.reportId, "P2 不能复用 P1 的报告");
  const row = deps.db.prepare("select cid from jobs where id = ?").get(p2) as { cid: number };
  assert.equal(Number(row.cid), 22, "P2 必须落到 pages[1].cid");
});

test("LLM 返回非 JSON 时报告标记 degraded 并落库", async () => {
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaResponse("BVDEGRAD0001"));
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: "足够长的内容。".repeat(30) }, { from: 60, to: 120, content: "足够长的内容。".repeat(30) }, { from: 120, to: 180, content: "足够长的内容。".repeat(30) }] }));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "我觉得这个视频很棒" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
  };
  const deps = depsWith({ fetchImpl: fake });
  const q = createQueue(deps);
  const jobId = await q.submit("BVDEGRAD0001");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "done");
const row = deps.db.prepare("select degraded, page from reports where id = ?").get(job.reportId) as {
    degraded: number;
    page: number;
  };
  assert.equal(Number(row.degraded), 1);
  assert.equal(Number(row.page), 1);
});

test("B站限流会先退避重试，不会直接掉进语音识别", async () => {
  let playerCalls = 0;
  const slept: number[] = [];
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaWithTitle("BVLIMIT00001", "足够长的内容讲解"));
    if (url.includes("x/player/v2")) {
      playerCalls++;
      if (playerCalls === 1) return new Response(JSON.stringify({ code: -352 }));
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    }
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: "足够长的内容。".repeat(30) }, { from: 60, to: 120, content: "足够长的内容。".repeat(30) }, { from: 120, to: 180, content: "足够长的内容。".repeat(30) }] }));
    return new Response(llmResponse());
  };
  let asrCalled = 0;
  const deps = depsWith({
    fetchImpl: fake,
    subtitleAttempts: 3,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    asrRunner: async () => {
      asrCalled++;
      return [];
    },
  });
  const q = createQueue(deps);
  const jobId = await q.submit("BVLIMIT00001");
  await q.onIdle();
  assert.equal(q.get(jobId)!.status, "done");
  assert.equal(slept.length, 1);
  assert.equal(playerCalls, 3);
  assert.equal(asrCalled, 0);
  const video = deps.db.prepare("select source from videos").get() as { source: string };
  assert.equal(video.source, "subtitle");
});

test("没登录时走语音识别，报告里明说原因", async () => {
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaResponse("BVNOLOG00001"));
    if (url.includes("x/player/v2")) return new Response(JSON.stringify({ code: -101 }));
    if (url.includes("playurl"))
      return new Response(
        JSON.stringify({ code: 0, data: { dash: { audio: [{ baseUrl: "https://a.bilivideo.com/1.m4s", bandwidth: 1 }] } } }),
      );
    if (url.startsWith("https://a.bilivideo.com/")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response(llmResponse());
  };
  const deps = depsWith({
    withCookie: false,
    fetchImpl: fake,
    prepareAudio: async () => {},
    asrRunner: async () => [{ from: 0, to: 30, text: "语音识别出来的内容".repeat(20) }],
  });
  const q = createQueue(deps);
  const jobId = await q.submit("BVNOLOG00001");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "done");
  const payload = JSON.parse(
    (deps.db.prepare("select payload_json from reports where id = ?").get(job.reportId) as { payload_json: string })
      .payload_json,
  ) as { caveats: string[] };
  assert.match(payload.caveats[0], /登录/);
});

test("语音识别用的音频文件用完就删，不在磁盘上堆积", async () => {
  const workDir = path.join("tmp", "work-cleanup");
  fs.rmSync(workDir, { recursive: true, force: true });
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaResponse("BVCLEAN00001"));
    if (url.includes("x/player/v2")) return new Response(JSON.stringify({ code: -101 }));
    if (url.includes("playurl"))
      return new Response(
        JSON.stringify({ code: 0, data: { dash: { audio: [{ baseUrl: "https://a.bilivideo.com/1.m4s", bandwidth: 1 }] } } }),
      );
    if (url.startsWith("https://a.bilivideo.com/")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response(llmResponse());
  };
  const deps = depsWith({
    withCookie: false,
    workDir,
    fetchImpl: fake,
    prepareAudio: async (_in: string, out: string) => fs.writeFileSync(out, "wav"),
    asrRunner: async () => [{ from: 0, to: 30, text: "语音识别出来的内容".repeat(20) }],
  });
  const q = createQueue(deps);
  await q.submit("BVCLEAN00001");
  await q.onIdle();
  const left = fs.existsSync(workDir) ? fs.readdirSync(workDir) : [];
  fs.rmSync(workDir, { recursive: true, force: true });
  assert.deepEqual(left, []);
});

test("字幕比视频长得多时判定不可信，且不入库", async () => {
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(shortMetaResponse("BVMISMATCH01", 172));
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(
        JSON.stringify({
          body: [
            { from: 0, to: 60, content: "这一段是别的视频的评测内容，".repeat(5) },
            { from: 1500, to: 1606, content: "结尾还在讲完全不相干的东西。".repeat(5) },
          ],
        }),
      );
    return new Response("{}");
  };
  const deps = depsWith({ fetchImpl: fake, asrReady: false });
  const q = createQueue(deps);
  const jobId = await q.submit("BVMISMATCH01");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /对不上/);
  const videos = deps.db.prepare("select count(*) as n from videos").get() as { n: number };
  assert.equal(Number(videos.n), 0, "不可信的字幕不能入库");
});

test("字幕不可信但装着语音识别时，改走识别并在报告里说明", async () => {
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(shortMetaResponse("BVMISMATCH02", 172));
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(
        JSON.stringify({ body: [{ from: 1500, to: 1606, content: "完全不相干的内容。".repeat(10) }] }),
      );
    if (url.includes("playurl"))
      return new Response(
        JSON.stringify({ code: 0, data: { dash: { audio: [{ baseUrl: "https://a.bilivideo.com/2.m4s", bandwidth: 1 }] } } }),
      );
    if (url.startsWith("https://a.bilivideo.com/")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response(llmResponse());
  };
  const deps = depsWith({
    fetchImpl: fake,
    prepareAudio: async () => {},
    asrRunner: async () => [{ from: 0, to: 60, text: "真正属于这个视频的内容".repeat(20) }],
  });
  const q = createQueue(deps);
  const jobId = await q.submit("BVMISMATCH02");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "done");
  const video = deps.db.prepare("select source, transcript_text from videos").get() as {
    source: string;
    transcript_text: string;
  };
  assert.equal(video.source, "asr");
  assert.equal(video.transcript_text.includes("完全不相干"), false);
  const payload = JSON.parse(
    (deps.db.prepare("select payload_json from reports where id = ?").get(job.reportId) as { payload_json: string })
      .payload_json,
  ) as { caveats: string[] };
  assert.match(payload.caveats[0], /对不上/);
});

test("强制重新生成会重抓字幕，不会沿用旧文字稿", async () => {
  let playerCalls = 0;
  let subtitleVersion = 1;
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view")) return new Response(metaWithTitle("BVFORCEREF01", "文字稿内容"));
    if (url.includes("x/player/v2")) {
      playerCalls++;
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    }
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(
        JSON.stringify({
          body: [
            {
              from: 0,
              to: 60,
              content: (subtitleVersion === 1 ? "第一版文字稿内容。" : "第二版文字稿内容。").repeat(20),
            },
            {
              from: 60,
              to: 120,
              content: (subtitleVersion === 1 ? "第一版文字稿内容。" : "第二版文字稿内容。").repeat(20),
            },
            {
              from: 120,
              to: 180,
              content: (subtitleVersion === 1 ? "第一版文字稿内容。" : "第二版文字稿内容。").repeat(20),
            },
          ],
        }),
      );
    return new Response(llmResponse());
  };
  const deps = depsWith({ fetchImpl: fake, subtitleAttempts: 2 });
  const q = createQueue(deps);
  await q.submit("BVFORCEREF01");
  await q.onIdle();
  subtitleVersion = 2;
  await q.submit("BVFORCEREF01", true);
  await q.onIdle();

  const row = deps.db.prepare("select transcript_text from videos").get() as { transcript_text: string };
  assert.equal(playerCalls, 4, "两次运行各取两次字幕");
  assert.match(row.transcript_text, /第二版/);
});

test("标题和文字稿毫无关系时在报告里提示可能抓错字幕", async () => {
  const fake = async (url: string) => {
    if (url.includes("x/web-interface/view"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            bvid: "BVTITLEMISS1",
            aid: 4,
            title: "毕业两年后的收入差距：月薪五千对比年入百万",
            owner: { name: "UP主" },
            duration: 600,
            pic: "",
            pages: [{ cid: 41, page: 1, duration: 600 }],
          },
        }),
      );
    if (url.includes("x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    if (url.includes("//aisubtitle.hdslb.com/x.json"))
      return new Response(
        JSON.stringify({
          body: [{ from: 0, to: 60, content: "弟弟在学校里找同学关注我的账号，顺便逛了食堂和宿舍。".repeat(10) }, { from: 60, to: 120, content: "弟弟在学校里找同学关注我的账号，顺便逛了食堂和宿舍。".repeat(10) }, { from: 120, to: 180, content: "弟弟在学校里找同学关注我的账号，顺便逛了食堂和宿舍。".repeat(10) }],
        }),
      );
    return new Response(llmResponse());
  };
  const deps = depsWith({ fetchImpl: fake });
  const q = createQueue(deps);
  const jobId = await q.submit("BVTITLEMISS1");
  await q.onIdle();
  const job = q.get(jobId)!;
  assert.equal(job.status, "done");
  const payload = JSON.parse(
    (deps.db.prepare("select payload_json from reports where id = ?").get(job.reportId) as { payload_json: string })
      .payload_json,
  ) as { caveats: string[] };
  assert.ok(payload.caveats.some((c) => /标题/.test(c)), "应提示标题与内容对不上");
});
