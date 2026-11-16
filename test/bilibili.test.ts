import test from "node:test";
import assert from "node:assert/strict";
import { parseVideoInput, fetchVideoMeta, resolveShortLink } from "../src/bilibili.ts";
import viewFixture from "./fixtures/view.json" with { type: "json" };

test("识别各种链接形态", () => {
  assert.deepEqual(parseVideoInput("https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&spm=x"), {
    ok: true,
    kind: "bvid",
    id: "BV1GJ411x7h7",
    p: 2,
  });
  assert.deepEqual(parseVideoInput("BV1GJ411x7h7"), { ok: true, kind: "bvid", id: "BV1GJ411x7h7", p: 1 });
  assert.deepEqual(parseVideoInput("https://m.bilibili.com/video/av80433022"), {
    ok: true,
    kind: "aid",
    id: "80433022",
    p: 1,
  });
  assert.equal(parseVideoInput("https://example.com/x").ok, false);
  assert.equal(parseVideoInput("https://www.bilibili.com/bangumi/play/ep123").ok, false);
  assert.equal(parseVideoInput("  b23.tv/abc  ").ok, true);
});

test("b23.tv 短链跟随 302 得到真实地址", async () => {
  const fake = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://www.bilibili.com/video/BV1GJ411x7h7" },
    });
  assert.equal(
    await resolveShortLink("https://b23.tv/abc", fake as never),
    "https://www.bilibili.com/video/BV1GJ411x7h7",
  );
});

test("?p=2 时必须用 pages[1].cid", async () => {
  const fake = async () => new Response(JSON.stringify(viewFixture), { status: 200 });
  const meta = await fetchVideoMeta("BV1GJ411x7h7", 2, fake as never);
  assert.equal(meta.cid, viewFixture.data.pages[1].cid);
  assert.equal(meta.pageCount, viewFixture.data.pages.length);
  assert.equal(meta.owner, "测试UP");
});

test("B站错误码翻译成可读原因", async () => {
  const fake = async () => new Response(JSON.stringify({ code: -404, message: "啥都木有" }), { status: 200 });
  await assert.rejects(fetchVideoMeta("BV1xx411c7mD", 1, fake as never), /视频不存在或已删除/);
});

test("纯数字 id 走 aid 参数", async () => {
  const seen: string[] = [];
  const fake = async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(viewFixture));
  };
  await fetchVideoMeta("80433022", 1, fake as never);
  assert.match(seen[0], /aid=80433022/);
});

test("?p 超过分 P 数量时报错，不静默退回第 1P", async () => {
  const fake = async () => new Response(JSON.stringify(viewFixture));
  await assert.rejects(fetchVideoMeta("BV1GJ411x7h7", 9, fake as never), /只有 2 个分 P/);
});

test("分 P 时长按该 P 自己的时长算，不是整片时长", async () => {
  const fixture = structuredClone(viewFixture) as typeof viewFixture & {
    data: { pages: { cid: number; page: number; duration?: number }[] };
  };
  fixture.data.pages[1].duration = 42;
  const fake = async () => new Response(JSON.stringify(fixture));
  const meta = await fetchVideoMeta("BV1GJ411x7h7", 2, fake as never);
  assert.equal(meta.duration, 42);
  assert.equal(meta.page, 2);
});
