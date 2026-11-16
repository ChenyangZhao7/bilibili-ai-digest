import test from "node:test";
import assert from "node:assert/strict";
import { fetchSubtitle, fetchBestSubtitle, parseVideoInput } from "../src/bilibili.ts";
import {
  cuesToParagraphs,
  paragraphsToTimestampedText,
  secondsToClock,
  mergeParagraphsForChunks,
  subtitleFitsVideo,
  titleLooksUnrelated,
  subtitleUsable,
} from "../src/subtitle.ts";
import body from "./fixtures/subtitle-body.json" with { type: "json" };

test("协议相对字幕地址补成 https 且带 Referer", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fake = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("/x/player/v2")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                { lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "//aisubtitle.hdslb.com/x.json" },
              ],
            },
          },
        }),
      );
    }
    return new Response(JSON.stringify(body));
  };
  const res = await fetchSubtitle("BV1GJ411x7h7", 1, "SESSDATA=s", fake as never);
  assert.equal(res.ok, true);
  assert.equal(calls[1].url, "https://aisubtitle.hdslb.com/x.json");
  assert.equal(calls[1].headers.Referer, "https://www.bilibili.com/");
  assert.equal(calls[0].headers.Cookie, "SESSDATA=s");
  if (res.ok) {
    assert.equal(res.lang, "ai-zh");
    assert.equal(res.cues[0].text, "第一句。");
  }
});

test("未登录 / 风控 / 无字幕三种失败要区分", async () => {
  const mk = (payload: unknown) => async () => new Response(JSON.stringify(payload));
  const notLoggedIn = await fetchSubtitle("B", 1, "SESSDATA=s", mk({ code: -101, message: "账号未登录" }) as never);
  const risk = await fetchSubtitle("B", 1, "SESSDATA=s", mk({ code: -352 }) as never);
  const none = await fetchSubtitle(
    "B",
    1,
    "SESSDATA=s",
    mk({ code: 0, data: { subtitle: { subtitles: [] } } }) as never,
  );
  const noCookie = await fetchSubtitle("B", 1, null, mk({ code: 0 }) as never);
  assert.equal(notLoggedIn.ok, false);
  assert.equal(risk.ok, false);
  assert.equal(none.ok, false);
  if (!notLoggedIn.ok) assert.equal(notLoggedIn.reason, "not_logged_in");
  if (!risk.ok) assert.equal(risk.reason, "risk_control");
  if (!none.ok) assert.equal(none.reason, "no_subtitle");
  if (!noCookie.ok) assert.equal(noCookie.reason, "not_logged_in");
});

test("分段：句末标点切开，静音 6 秒切开，单段不超 300 字", () => {
  const cues = [
    { from: 0, to: 2, text: "大家好" },
    { from: 2, to: 4, text: "今天讲AI。" },
    { from: 30, to: 32, text: "第二部分。" },
    { from: 32, to: 34, text: "很长".repeat(200) },
  ];
  const paras = cuesToParagraphs(cues);
  assert.equal(paras[0].text, "大家好今天讲AI。");
  assert.equal(paras[1].start, 30);
  assert.ok(paras.every((p) => p.text.length <= 300));
  assert.equal(secondsToClock(3725), "62:05");
  assert.ok(paragraphsToTimestampedText(paras).startsWith("[00:00]"));
  assert.equal(paras[paras.length - 1].end, 34);
});

test("分块不丢段且每块在预算内", () => {
  const paras = Array.from({ length: 40 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9,
    text: "字".repeat(200),
  }));
  const chunks = mergeParagraphsForChunks(paras, 1000);
  assert.equal(chunks.flat().length, 40);
  assert.ok(chunks.every((c) => c.reduce((n, p) => n + p.text.length, 0) <= 1000));
});

test("字幕地址不在白名单域名就拒绝，不去拉取", async () => {  const calls: string[] = [];
  const fake = async (url: string) => {
    calls.push(url);
    if (url.includes("/x/player/v2")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//evil.example.com/x.json" }] } },
        }),
      );
    }
    return new Response(JSON.stringify({ body: [] }));
  };
  const res = await fetchSubtitle("BV1GJ411x7h7", 1, "SESSDATA=s", fake as never);
  assert.equal(res.ok, false);
  assert.equal(calls.length, 1, "不该去请求白名单外的地址");
});

test("B站连续返回不同字幕时，挑和标题最相关的一份", async () => {
  let n = 0;
  const bodies = [
    "兄弟们今天咱们聊聊别的",
    "那五分化呢五次把全身练一遍",
    "问大家一个问题啊你觉得同一个学校学生毕业两年以后他的收入差距能有多大",
  ];
  const fake = async (url: string) => {
    if (url.includes("/x/player/v2")) {
      n++;
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: `//aisubtitle.hdslb.com/x${n}.json` }] } },
        }),
      );
    }
    const idx = Number(url.match(/x(\d+)\.json/)?.[1] ?? "1") - 1;
    const text = bodies[Math.min(idx, bodies.length - 1)];
    return new Response(
      JSON.stringify({
        body: [
          { from: 0, to: 160, content: text },
          { from: 160, to: 320, content: text },
          { from: 320, to: 480, content: text },
        ],
      }),
    );
  };
  const pick = await fetchBestSubtitle({
    bvid: "BV1eT421672q",
    cid: 1,
    cookie: "SESSDATA=s",
    duration: 486,
    title: "毕业2年后的收入差距：月薪5千vs年入百万，打工真的无法致富吗？",
    fetchImpl: fake as never,
    attempts: 4,
    sleep: async () => {},
  });
  assert.equal(pick.ok, true);
  if (pick.ok) {
    assert.match(pick.cues[0].text, /收入差距/);
    assert.ok(pick.titleScore >= 2);
  }
});

test("候选全是广告乱码时明确说不可靠", async () => {
  const fake = async (url: string) => {
    if (url.includes("/x/player/v2"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
      );
    return new Response(
      JSON.stringify({ body: [{ from: 0.3, to: 28.6, content: "敲重点 投降 包村 拥 威信 扫" }] }),
    );
  };
  const pick = await fetchBestSubtitle({
    bvid: "BV1",
    cid: 1,
    cookie: "SESSDATA=s",
    duration: 486,
    title: "随便什么标题都可以",
    fetchImpl: fake as never,
    attempts: 2,
    sleep: async () => {},
  });
  assert.equal(pick.ok, false);
  if (!pick.ok) assert.equal(pick.reason, "unreliable");
});

test("伪造的 bilibili 域名不被当成 B站链接", () => {
  assert.equal(parseVideoInput("https://evilbilibili.com/video/BV1GJ411x7h7").ok, false);
  assert.equal(parseVideoInput("https://www.bilibili.com/video/BV1GJ411x7h7").ok, true);
});

test("字幕时长明显超过视频时长时判定为不可信", () => {
  const videoDuration = 172;
  assert.equal(subtitleFitsVideo([{ from: 0, to: 160, text: "a" }, { from: 160, to: 1606, text: "b" }], videoDuration), false);
  assert.equal(subtitleFitsVideo([{ from: 0, to: 100, text: "a" }, { from: 100, to: 190, text: "b" }], videoDuration), true);
  assert.equal(subtitleFitsVideo([{ from: 0, to: 50, text: "a" }], 0), true, "时长未知时不拦");
});

test("标题关键词在文字稿里一个都不出现时判为不相关", () => {
  const campus =
    "弟弟在学校里找同学关注我的账号，顺便逛了食堂和宿舍，还聊了社团和洗澡卡怎么收费。";
  assert.equal(titleLooksUnrelated("毕业两年后的收入差距：月薪五千对比年入百万", campus), true);
  assert.equal(titleLooksUnrelated("浙江秋天的眼镜蛇有多猖狂？就在我们身边", "今天带大家找舟山眼镜蛇，就在农田边上"), false);
  assert.equal(titleLooksUnrelated("Vlog", campus), false, "太短的标题不判断");
});

test("字幕只覆盖视频一小段时判为不可用", () => {
  const shortCover = [
    { from: 0.3, to: 10, text: "敲重点 投降 包村 拥 威信 扫".repeat(3) },
    { from: 10, to: 20, text: "敲重点 投降 包村 拥 威信 扫".repeat(3) },
    { from: 20, to: 28.6, text: "敲重点 投降 包村 拥 威信 扫".repeat(3) },
  ];
  assert.equal(subtitleUsable(shortCover, 486), false);
  const fullCover = [
    { from: 0, to: 120, text: "正常内容".repeat(20) },
    { from: 120, to: 240, text: "正常内容".repeat(20) },
    { from: 240, to: 480, text: "正常内容".repeat(20) },
  ];
  assert.equal(subtitleUsable(fullCover, 486), true);
});

test("多次取到互相矛盾且都不匹配标题的字幕时拒绝使用", async () => {
  let n = 0;
  const fake = async (url: string) => {
    if (url.includes("/x/player/v2")) {
      n++;
      return new Response(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: `//aisubtitle.hdslb.com/x${n}.json` }] } },
        }),
      );
    }
    const idx = Number(url.match(/x(\d+)\.json/)?.[1] ?? "1");
    const text = idx === 1 ? "珊瑚保育项目的幕后花絮".repeat(20) : "今天我们要飞一千五百公里".repeat(20);
    return new Response(
      JSON.stringify({
        body: [
          { from: 0, to: 160, content: text },
          { from: 160, to: 320, content: text },
          { from: 320, to: 480, content: text },
        ],
      }),
    );
  };
  const pick = await fetchBestSubtitle({
    bvid: "BV1",
    cid: 1,
    cookie: "SESSDATA=s",
    duration: 486,
    title: "毕业两年后的收入差距：月薪五千对比年入百万",
    fetchImpl: fake as never,
    attempts: 2,
    sleep: async () => {},
  });
  assert.equal(pick.ok, false);
  if (!pick.ok) assert.equal(pick.reason, "unreliable");
});
