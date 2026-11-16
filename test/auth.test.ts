import test from "node:test";
import assert from "node:assert/strict";
import { createQr, pollQr, cookieHeader, checkLogin } from "../src/auth.ts";
import { openDb, initSchema } from "../src/db.ts";
import { saveCookie } from "../src/settings.ts";
import { getCookie } from "../src/auth.ts";

test("生成二维码并渲染成 data URL", async () => {
  const fake = async () =>
    new Response(
      JSON.stringify({ code: 0, data: { url: "https://account.bilibili.com/h5/x", qrcode_key: "KEY123" } }),
    );
  const qr = await createQr(fake as never);
  assert.equal(qr.key, "KEY123");
  assert.ok(qr.pngDataUrl.startsWith("data:image/png;base64,"));
});

test("轮询把 B站内层 code 映射成状态，成功时收齐 cookie", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "SESSDATA=abc; Path=/; Domain=.bilibili.com");
  headers.append("set-cookie", "bili_jct=def; Path=/");
  headers.append("set-cookie", "DedeUserID=42; Path=/");
  const ok = async () => new Response(JSON.stringify({ code: 0, data: { code: 0 } }), { headers });
  const r = await pollQr("K", ok as never);
  assert.equal(r.state, "confirmed");
  assert.equal(r.cookie?.SESSDATA, "abc");
  assert.equal(r.cookie?.bili_jct, "def");
  assert.equal(r.cookie?.DedeUserID, "42");

  const waiting = async () => new Response(JSON.stringify({ code: 0, data: { code: 86101 } }));
  assert.equal((await pollQr("K", waiting as never)).state, "waiting");
  const scanned = async () => new Response(JSON.stringify({ code: 0, data: { code: 86090 } }));
  assert.equal((await pollQr("K", scanned as never)).state, "scanned");
  const expired = async () => new Response(JSON.stringify({ code: 0, data: { code: 86038 } }));
  assert.equal((await pollQr("K", expired as never)).state, "expired");
});

test("cookieHeader 只发这四个字段", () => {
  assert.equal(
    cookieHeader({ SESSDATA: "s", bili_jct: "j", DedeUserID: "1", buvid3: "b" }),
    "SESSDATA=s; bili_jct=j; DedeUserID=1; buvid3=b",
  );
});

test("nav 校验登录态", async () => {
  const fake = async () => new Response(JSON.stringify({ code: 0, data: { isLogin: true, uname: "老王" } }));
  assert.deepEqual(await checkLogin({ SESSDATA: "s", bili_jct: "j", DedeUserID: "1", buvid3: "b" }, fake as never), {
    isLogin: true,
    uname: "老王",
  });
});

test("getCookie 从数据库读回登录态", () => {
  const db = openDb(":memory:");
  initSchema(db);
  assert.equal(getCookie(db), null);
  saveCookie(db, { SESSDATA: "s", bili_jct: "j", DedeUserID: "1", buvid3: "b" });
  assert.equal(getCookie(db)?.SESSDATA, "s");
});
