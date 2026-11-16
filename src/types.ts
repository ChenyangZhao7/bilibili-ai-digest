export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type BiliCookie = {
  SESSDATA: string;
  bili_jct: string;
  DedeUserID: string;
  buvid3: string;
};

export type Cue = { from: number; to: number; text: string };

export type Paragraph = { start: number; end: number; text: string };
