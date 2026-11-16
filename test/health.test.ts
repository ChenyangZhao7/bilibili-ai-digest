import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.ts";

test("health 返回 ok 与版本号", async () => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  server.close();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
});
