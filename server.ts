import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const PORT = 4318;
export const HOST = "127.0.0.1";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  app.use(express.static(path.join(here, "public")));

  return app;
}

const isMain = process.argv[1]
  ? import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
  : false;

if (isMain) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`报告服务已启动：http://${HOST}:${PORT}`);
    console.log("关掉这个窗口就等于关闭服务。");
  });
}
