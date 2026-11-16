import test from "node:test";
import assert from "node:assert/strict";
import {
  openDb,
  initSchema,
  setSetting,
  getSetting,
  getSettings,
  maskSecret,
  upsertVideo,
  getVideo,
  insertReport,
  getReport,
  listReports,
  findRecentReport,
  insertJob,
  updateJob,
  getJob,
} from "../src/db.ts";
import { saveCookie, loadSettings, saveLlmSettings, hasLlmKey } from "../src/settings.ts";

test("maskSecret 不泄露中间内容", () => {
  assert.equal(maskSecret("SESSDATAabcdefgh12345678"), "SESS***78");
  assert.equal(maskSecret("short"), "***");
});

test("设置读写往返，getSettings 不返回明文 key", () => {
  const db = openDb(":memory:");
  initSchema(db);
  setSetting(db, "llm_api_key", "sk-1234567890abcdef");
  assert.equal(getSetting(db, "llm_api_key"), "sk-1234567890abcdef");
  assert.equal(JSON.stringify(getSettings(db)).includes("1234567890abcdef"), false);
  assert.equal(hasLlmKey(db), true);
});

test("视频按 bvid+cid 唯一，重复写入覆盖", () => {
  const db = openDb(":memory:");
  initSchema(db);
  const base = {
    bvid: "BV1xx411c7mD",
    cid: 1,
    title: "t1",
    owner: "u",
    duration: 10,
    cover: "",
    source: "subtitle" as const,
    transcriptJson: "[]",
    transcriptText: "",
    fetchedAt: 1,
  };
  upsertVideo(db, base);
  upsertVideo(db, { ...base, title: "t2" });
  assert.equal(getVideo(db, "BV1xx411c7mD", 1)?.title, "t2");
});

test("cookie 存成 JSON，loadSettings 只返回结构化字段", () => {
  const db = openDb(":memory:");
  initSchema(db);
  saveCookie(db, { SESSDATA: "s", bili_jct: "j", DedeUserID: "1", buvid3: "b" });
  assert.equal(loadSettings(db).biliCookie?.DedeUserID, "1");
});

test("报告可按标题/UP主/正文搜索，并带视频元数据", () => {
  const db = openDb(":memory:");
  initSchema(db);
  upsertVideo(db, {
    bvid: "BV1", cid: 1, title: "深度讲解", owner: "老王", duration: 60, cover: "",
    source: "subtitle", transcriptJson: "[]", transcriptText: "正文", fetchedAt: 1,
  });
  insertReport(db, {
    id: "r1", bvid: "BV1", cid: 1, model: "m", promptVersion: "p",
    payloadJson: "{}", markdown: "# 报告", tokensIn: 1, tokensOut: 1, createdAt: 1000,
  });
  const byTitle = listReports(db, "深度", 10, 0);
  const byOwner = listReports(db, "老王", 10, 0);
  const none = listReports(db, "不存在", 10, 0);
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].title, "深度讲解");
  assert.equal(byOwner.length, 1);
  assert.equal(none.length, 0);
  assert.equal(getReport(db, "r1")?.markdown, "# 报告");
  assert.equal(findRecentReport(db, "BV1", 1, 24, 1000_000)?.id, "r1");
  assert.equal(findRecentReport(db, "BV1", 1, 24, 1000 + 25 * 3600_000), null);
});

test("job 状态可更新，未知 job 返回 null", () => {
  const db = openDb(":memory:");
  initSchema(db);
  insertJob(db, {
    id: "j1", url: "BV1", bvid: null, cid: null, status: "queued", stage: "parsing",
    progress: 0, error: null, reportId: null, createdAt: 1, updatedAt: 1,
  });
  updateJob(db, "j1", { status: "running", progress: 40, stage: "subtitle" });
  assert.equal(getJob(db, "j1")?.progress, 40);
  assert.equal(getJob(db, "nope"), null);
});

test("损坏的 cookie JSON 不让程序崩溃", () => {
  const db = openDb(":memory:");
  initSchema(db);
  setSetting(db, "bili_cookie", "{not json");
  assert.equal(loadSettings(db).biliCookie, null);
  saveLlmSettings(db, { baseUrl: "https://x/v1", model: "m", apiKey: "k" });
  assert.equal(loadSettings(db).llmBaseUrl, "https://x/v1");
});
