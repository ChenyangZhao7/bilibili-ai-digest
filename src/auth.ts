import QRCode from "qrcode";
import type { DatabaseSync } from "node:sqlite";
import type { BiliCookie, FetchLike } from "./types.ts";
import { BILI_HEADERS } from "./bilibili.ts";
import { getSetting, setSetting } from "./db.ts";

export type QrState = "waiting" | "scanned" | "declined" | "expired" | "confirmed";

export type QrPollResult = { state: QrState; cookie?: BiliCookie };

const PASSPORT = "https://passport.bilibili.com/x/passport-login/web/qrcode";

export function cookieHeader(c: BiliCookie): string {
  return `SESSDATA=${c.SESSDATA}; bili_jct=${c.bili_jct}; DedeUserID=${c.DedeUserID}; buvid3=${c.buvid3}`;
}

export function getCookie(db: DatabaseSync): BiliCookie | null {
  const raw = getSetting(db, "bili_cookie");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BiliCookie>;
    return {
      SESSDATA: String(parsed.SESSDATA ?? ""),
      bili_jct: String(parsed.bili_jct ?? ""),
      DedeUserID: String(parsed.DedeUserID ?? ""),
      buvid3: String(parsed.buvid3 ?? ""),
    };
  } catch {
    return null;
  }
}

export function saveLoginCookie(db: DatabaseSync, cookie: BiliCookie): void {
  setSetting(db, "bili_cookie", JSON.stringify(cookie));
}

export async function createQr(fetchImpl: FetchLike): Promise<{ key: string; url: string; pngDataUrl: string }> {
  const res = await fetchImpl(`${PASSPORT}/generate`, { headers: BILI_HEADERS() });
  const json = (await res.json()) as { code: number; message?: string; data?: { url: string; qrcode_key: string } };
  if (json.code !== 0 || !json.data) {
    throw new Error(`二维码生成失败：${json.message ?? json.code}`);
  }
  const pngDataUrl = await QRCode.toDataURL(json.data.url, { margin: 1, width: 320 });
  return { key: json.data.qrcode_key, url: json.data.url, pngDataUrl };
}

function readSetCookie(headers: Headers): Record<string, string> {
  const jar: Record<string, string> = {};
  const raw =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_]+=)/);
  for (const line of raw) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

async function fetchBuvid3(fetchImpl: FetchLike): Promise<string> {
  try {
    const res = await fetchImpl("https://api.bilibili.com/x/frontend/finger/spi", { headers: BILI_HEADERS() });
    const json = (await res.json()) as { data?: { b_3?: string } };
    return json.data?.b_3 ?? "";
  } catch {
    return "";
  }
}

export async function pollQr(key: string, fetchImpl: FetchLike): Promise<QrPollResult> {
  const res = await fetchImpl(`${PASSPORT}/poll?qrcode_key=${encodeURIComponent(key)}`, {
    headers: BILI_HEADERS(),
  });
  const json = (await res.json()) as { code: number; data?: { code: number; message?: string } };
  const inner = json.data?.code;

  if (json.code !== 0) return { state: "expired" };
  if (inner === 86101) return { state: "waiting" };
  if (inner === 86090) return { state: "scanned" };
  if (inner === 86038) return { state: "expired" };
  if (inner !== 0) return { state: "declined" };

  const jar = readSetCookie(res.headers);
  if (!jar.SESSDATA) return { state: "declined" };
  const buvid3 = jar.buvid3 ?? (await fetchBuvid3(fetchImpl));
  return {
    state: "confirmed",
    cookie: {
      SESSDATA: jar.SESSDATA ?? "",
      bili_jct: jar.bili_jct ?? "",
      DedeUserID: jar.DedeUserID ?? "",
      buvid3,
    },
  };
}

export async function checkLogin(
  cookie: BiliCookie,
  fetchImpl: FetchLike,
): Promise<{ isLogin: boolean; uname: string | null }> {
  const res = await fetchImpl("https://api.bilibili.com/x/web-interface/nav", {
    headers: BILI_HEADERS({ Cookie: cookieHeader(cookie) }),
  });
  const json = (await res.json()) as { code: number; data?: { isLogin?: boolean; uname?: string } };
  return { isLogin: Boolean(json.data?.isLogin), uname: json.data?.uname ?? null };
}
