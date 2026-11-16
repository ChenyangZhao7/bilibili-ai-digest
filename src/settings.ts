import type { DatabaseSync } from "node:sqlite";
import type { BiliCookie } from "./types.ts";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  getSetting,
  getSettings,
  setSetting,
  type Settings,
} from "./db.ts";

export function loadSettings(db: DatabaseSync): Settings {
  return getSettings(db);
}

export function saveCookie(db: DatabaseSync, cookie: BiliCookie): void {
  setSetting(db, "bili_cookie", JSON.stringify(cookie));
}

export function saveLlmSettings(
  db: DatabaseSync,
  input: { baseUrl?: string; model?: string; apiKey?: string },
): void {
  if (input.baseUrl !== undefined && input.baseUrl.trim() !== "") {
    setSetting(db, "llm_base_url", input.baseUrl.trim());
  }
  if (input.model !== undefined && input.model.trim() !== "") {
    setSetting(db, "llm_model", input.model.trim());
  }
  if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
    setSetting(db, "llm_api_key", input.apiKey.trim());
  }
}

export function hasLlmKey(db: DatabaseSync): boolean {
  const key = getSetting(db, "llm_api_key");
  return typeof key === "string" && key.length > 0;
}

export function getLlmConfig(db: DatabaseSync): { baseUrl: string; model: string; apiKey: string } {
  return {
    baseUrl: getSetting(db, "llm_base_url") ?? DEFAULT_LLM_BASE_URL,
    model: getSetting(db, "llm_model") ?? DEFAULT_LLM_MODEL,
    apiKey: getSetting(db, "llm_api_key") ?? "",
  };
}
