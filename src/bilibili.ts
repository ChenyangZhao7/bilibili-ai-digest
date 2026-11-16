import type { FetchLike } from "./types.ts";

export type { FetchLike };

export type VideoInput =
  | { ok: true; kind: "bvid" | "aid" | "short"; id: string; p: number }
  | { ok: false; reason: string };

export type VideoMeta = {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  owner: string;
  duration: number;
  cover: string;
  pageCount: number;
};

export type BiliError = {
  kind: "not_found" | "unsupported" | "restricted" | "http";
  message: string;
};

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export function BILI_HEADERS(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": UA,
    Referer: "https://www.bilibili.com/",
    ...extra,
  };
}

function biliError(kind: BiliError["kind"], message: string): Error {
  return Object.assign(new Error(message), { bili: { kind, message } satisfies BiliError });
}

const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const AV_RE = /^av(\d+)$/i;

export function parseVideoInput(raw: string): VideoInput {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, reason: "输入是空的，粘一个 B站 链接试试" };

  if (BV_RE.test(input)) return { ok: true, kind: "bvid", id: input, p: 1 };
  const avOnly = AV_RE.exec(input);
  if (avOnly) return { ok: true, kind: "aid", id: avOnly[1], p: 1 };
  if (/^\d+$/.test(input)) return { ok: true, kind: "aid", id: input, p: 1 };

  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "认不出这个链接，支持 BV号 / av号 / b站视频页 / b23.tv" };
  }

  const host = url.hostname.toLowerCase();
  const pParam = Number(url.searchParams.get("p"));
  const p = Number.isInteger(pParam) && pParam > 0 ? pParam : 1;

  if (host.endsWith("b23.tv") || host.endsWith("bili2233.cn")) {
    return { ok: true, kind: "short", id: url.toString(), p };
  }

  if (!host.endsWith("bilibili.com")) {
    return { ok: false, reason: "认不出这个链接，支持 BV号 / av号 / b站视频页 / b23.tv" };
  }

  if (/\/(bangumi|live|cheese)\//.test(url.pathname)) {
    return { ok: false, reason: "暂不支持番剧、直播回放和课程" };
  }

  const bv = /\/video\/(BV[0-9A-Za-z]{10})/.exec(url.pathname);
  if (bv) return { ok: true, kind: "bvid", id: bv[1], p };

  const av = /\/video\/av(\d+)/i.exec(url.pathname);
  if (av) return { ok: true, kind: "aid", id: av[1], p };

  return { ok: false, reason: "认不出这个链接，支持 BV号 / av号 / b站视频页 / b23.tv" };
}

export async function resolveShortLink(url: string, fetchImpl: FetchLike): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetchImpl(current, { method: "GET", redirect: "manual", headers: BILI_HEADERS() });
    const location = res.headers.get("location");
    if (!location) return current;
    current = new URL(location, current).toString();
    if (!/b23\.tv|bili2233\.cn/.test(new URL(current).hostname)) return current;
  }
  return current;
}

type ViewResponse = {
  code: number;
  message?: string;
  data?: {
    bvid: string;
    aid: number;
    title: string;
    owner?: { name?: string };
    duration?: number;
    pic?: string;
    pages?: { cid: number; page: number }[];
  };
};

export async function fetchVideoMeta(id: string, p: number, fetchImpl: FetchLike): Promise<VideoMeta> {
  const param = /^\d+$/.test(id) ? `aid=${id}` : `bvid=${encodeURIComponent(id)}`;
  const res = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?${param}`, {
    headers: BILI_HEADERS(),
  });
  if (!res.ok) throw biliError("http", `B站接口返回 HTTP ${res.status}`);
  const json = (await res.json()) as ViewResponse;

  switch (json.code) {
    case 0:
      break;
    case -404:
      throw biliError("not_found", "视频不存在或已删除");
    case -403:
      throw biliError("restricted", "该视频有地区或权限限制");
    case 62002:
    case 62004:
      throw biliError("not_found", "视频已失效或被隐藏");
    default:
      throw biliError("http", `B站返回错误：${json.message ?? json.code}`);
  }

  const data = json.data;
  if (!data) throw biliError("http", "B站没有返回视频信息");

  const pages = data.pages ?? [];
  const page = pages[p - 1] ?? pages[0];
  if (!page) throw biliError("http", "这个视频没有可播放的分 P");

  return {
    bvid: data.bvid,
    aid: data.aid,
    cid: page.cid,
    title: data.title,
    owner: data.owner?.name ?? "",
    duration: data.duration ?? 0,
    cover: data.pic ?? "",
    pageCount: pages.length,
  };
}
