import type { Cue, FetchLike } from "./types.ts";

export type { FetchLike };

export type VideoInput =
  | { ok: true; kind: "bvid" | "aid" | "short"; id: string; p: number }
  | { ok: false; reason: string };

export type VideoMeta = {
  bvid: string;
  aid: number;
  cid: number;
  page: number;
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

export const MEDIA_HOST_SUFFIXES = [
  "hdslb.com",
  "bilivideo.com",
  "bilivideo.cn",
  "akamaized.net",
  "szbdyd.com",
  "bilibili.com",
];

export function hostAllowed(url: string, suffixes: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isBilibiliHost(host: string): boolean {
  return host === "bilibili.com" || host.endsWith(".bilibili.com");
}

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

  if (!isBilibiliHost(host)) {
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
    pages?: { cid: number; page: number; duration?: number }[];
  };
};

export async function fetchVideoMeta(id: string, p: number, fetchImpl: FetchLike): Promise<VideoMeta> {  const param = /^\d+$/.test(id) ? `aid=${id}` : `bvid=${encodeURIComponent(id)}`;
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
  if (pages.length === 0) throw biliError("http", "这个视频没有可播放的分 P");
  if (p > pages.length) {
    throw biliError("http", `该视频只有 ${pages.length} 个分 P，链接里的 p=${p} 超出了范围`);
  }
  const page = pages[p - 1];

  return {
    bvid: data.bvid,
    aid: data.aid,
    cid: page.cid,
    page: p,
    title: data.title,
    owner: data.owner?.name ?? "",
    duration: page.duration ?? data.duration ?? 0,
    cover: data.pic ?? "",
    pageCount: pages.length,
  };
}

export type SubtitleResult =
  | { ok: true; lang: string; cues: Cue[] }
  | { ok: false; reason: "not_logged_in" | "risk_control" | "no_subtitle" | "http"; detail: string };

type PlayerResponse = {
  code: number;
  message?: string;
  data?: {
    subtitle?: {
      subtitles?: { lan: string; lan_doc?: string; subtitle_url?: string }[];
    };
  };
};

type SubtitleBody = { body?: { from: number; to: number; content: string }[] };

export async function fetchSubtitle(
  bvid: string,
  cid: number,
  cookie: string | null,
  fetchImpl: FetchLike,
): Promise<SubtitleResult> {
  if (!cookie) return { ok: false, reason: "not_logged_in", detail: "还没有登录 B站" };

  const res = await fetchImpl(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
    { headers: BILI_HEADERS({ Cookie: cookie }) },
  );
  if (!res.ok) return { ok: false, reason: "http", detail: `B站接口返回 HTTP ${res.status}` };
  const json = (await res.json()) as PlayerResponse;

  if (json.code === -101) return { ok: false, reason: "not_logged_in", detail: "登录已过期，需要重新扫码" };
  if (json.code === -352 || json.code === -412) {
    return { ok: false, reason: "risk_control", detail: "B站限流了，等我一会儿再试" };
  }
  if (json.code !== 0) return { ok: false, reason: "http", detail: `B站返回错误：${json.message ?? json.code}` };

  const list = json.data?.subtitle?.subtitles ?? [];
  if (list.length === 0) return { ok: false, reason: "no_subtitle", detail: "这个视频没有字幕" };

  const picked = list.find((s) => s.lan === "ai-zh") ?? list.find((s) => s.lan.includes("zh")) ?? list[0];
  if (!picked.subtitle_url) return { ok: false, reason: "no_subtitle", detail: "字幕地址为空" };

  const url = picked.subtitle_url.startsWith("//") ? `https:${picked.subtitle_url}` : picked.subtitle_url;
  if (!hostAllowed(url, MEDIA_HOST_SUFFIXES)) {
    return { ok: false, reason: "http", detail: `字幕地址不在 B站域名下，拒绝访问：${url.slice(0, 60)}` };
  }
  const subRes = await fetchImpl(url, { headers: BILI_HEADERS() });
  if (!subRes.ok) return { ok: false, reason: "http", detail: `字幕文件下载失败 HTTP ${subRes.status}` };
  const body = (await subRes.json()) as SubtitleBody;

  const cues: Cue[] = (body.body ?? []).map((c) => ({ from: c.from, to: c.to, text: c.content }));
  if (cues.length === 0) return { ok: false, reason: "no_subtitle", detail: "字幕内容为空" };

  return { ok: true, lang: picked.lan, cues };
}
