import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.ts";
import { openDb, initSchema } from "../src/db.ts";

async function start(opts: { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const db = openDb(":memory:");
  initSchema(db);
  const fakeFetch =
    opts.fetchImpl ??
    (async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 }));
  const app = createApp({ db, deps: { fetchImpl: fakeFetch as never } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, server, db };
}

test("非法链接立即返回可读中文原因，不是 500", async () => {
  const { base, server } = await start();
  const res = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/x" }),
  });
  const body = await res.json();
  server.close();
  assert.equal(res.status, 400);
  assert.match(body.error, /认不出这个链接/);
});

test("未登录时 analyze 也能排队，job 有 id", async () => {
  const { base, server } = await start();
  const res = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "BV1GJ411x7h7" }),
  });
  const body = await res.json();
  const job = await fetch(`${base}/api/jobs/${body.jobId}`).then((r) => r.json());
  server.close();
  assert.equal(res.status, 200);
  assert.ok(body.jobId);
  assert.ok(["queued", "running", "failed", "done"].includes(job.status));
});

test("设置接口永不明文返回 key，测试连接的响应也不含 key", async () => {
  const { base, server } = await start();
  await fetch(`${base}/api/settings/llm`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "sk-super-secret-123456",
    }),
  });
  const s = await fetch(`${base}/api/settings`).then((r) => r.json());
  const t = await fetch(`${base}/api/settings/llm/test`, { method: "POST" }).then((r) => r.json());
  server.close();
  assert.equal(JSON.stringify(s).includes("sk-super-secret-123456"), false);
  assert.equal(JSON.stringify(t).includes("sk-super-secret-123456"), false);
  assert.equal(s.llmBaseUrl, "https://api.deepseek.com/v1");
});

test("报告列表、详情、删除", async () => {
  const { base, server, db } = await start();
  db.prepare(
    "insert into videos (bvid,cid,title,owner,duration,cover,source,transcript_json,transcript_text,fetched_at) values ('BV1',1,'标题','UP',60,'','subtitle','[]','',1)",
  ).run();
  db.prepare(
    "insert into reports (id,bvid,cid,model,prompt_version,payload_json,markdown,tokens_in,tokens_out,created_at) values ('r1','BV1',1,'m','p','{\"tldr\":[\"x\"]}','# 报告',1,1,1)",
  ).run();
  const list = await fetch(`${base}/api/reports?q=标题`).then((r) => r.json());
  const one = await fetch(`${base}/api/reports/r1`).then((r) => r.json());
  const del = await fetch(`${base}/api/reports/r1`, { method: "DELETE" }).then((r) => r.json());
  const after = await fetch(`${base}/api/reports/r1`);
  server.close();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].title, "标题");
  assert.equal(list.items[0].markdown, undefined, "列表不应带正文");
  assert.equal(one.markdown, "# 报告");
  assert.equal(one.meta.title, "标题");
  assert.equal(one.payload.tldr[0], "x");
  assert.equal(del.ok, true);
  assert.equal(after.status, 404);
});
