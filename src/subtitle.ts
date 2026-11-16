import type { Cue, Paragraph } from "./types.ts";

const MAX_PARAGRAPH_CHARS = 300;
const SILENCE_GAP_SEC = 6;

export function secondsToClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function splitLongCue(cue: Cue, size: number): Cue[] {
  if (cue.text.length <= size) return [cue];
  const parts: Cue[] = [];
  const duration = Math.max(0.001, cue.to - cue.from);
  for (let i = 0; i < cue.text.length; i += size) {
    const text = cue.text.slice(i, i + size);
    const from = cue.from + (duration * i) / cue.text.length;
    const to = cue.from + (duration * Math.min(cue.text.length, i + size)) / cue.text.length;
    parts.push({ from, to, text });
  }
  return parts;
}

export function subtitleFitsVideo(cues: Cue[], duration: number): boolean {
  if (!duration || duration <= 0) return true;
  const maxTo = cues.reduce((max, cue) => Math.max(max, cue.to), 0);
  return maxTo <= Math.max(duration + 30, duration * 1.2);
}

export function titleLooksUnrelated(title: string, text: string): boolean {
  return titleScore(title, text) === 0 && titleGrams(title).size >= 5;
}

function titleGrams(title: string): Set<string> {
  const cleanTitle = title.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
  const grams = new Set<string>();
  for (let i = 0; i + 1 < cleanTitle.length; i++) {
    grams.add(cleanTitle.slice(i, i + 2));
  }
  return grams;
}

export function titleScore(title: string, text: string): number {
  const grams = titleGrams(title);
  if (grams.size === 0) return 0;
  const body = text.replace(/\s/g, "");
  let hits = 0;
  for (const gram of grams) {
    if (body.includes(gram)) hits++;
  }
  return hits;
}

export function subtitleUsable(cues: Cue[], duration: number): boolean {
  if (!subtitleFitsVideo(cues, duration)) return false;
  const chars = cues.reduce((n, cue) => n + cue.text.length, 0);
  if (duration >= 60 && (cues.length < 3 || chars < 80)) return false;
  if (duration > 0 && chars < 20) return false;
  if (duration >= 120) {
    const maxTo = cues.reduce((max, cue) => Math.max(max, cue.to), 0);
    if (maxTo < duration * 0.25) return false;
  }
  return true;
}

export function cuesToParagraphs(cues: Cue[]): Paragraph[] {
  const flat = cues
    .filter((c) => c.text.trim() !== "")
    .flatMap((c) => splitLongCue({ ...c, text: c.text.trim() }, MAX_PARAGRAPH_CHARS));

  const paras: Paragraph[] = [];
  let buf: Paragraph | null = null;

  const flush = () => {
    if (buf) paras.push(buf);
    buf = null;
  };

  for (const cue of flat) {
    if (!buf) {
      buf = { start: cue.from, end: cue.to, text: cue.text };
      continue;
    }
    const gap = cue.from - buf.end;
    const overflow = buf.text.length + cue.text.length > MAX_PARAGRAPH_CHARS;
    if (gap >= SILENCE_GAP_SEC || overflow) {
      flush();
      buf = { start: cue.from, end: cue.to, text: cue.text };
      continue;
    }
    buf.text += cue.text;
    buf.end = cue.to;
  }
  flush();

  return paras;
}

export function paragraphsToTimestampedText(paras: Paragraph[]): string {
  return paras.map((p) => `[${secondsToClock(p.start)}] ${p.text}`).join("\n");
}

export function mergeParagraphsForChunks(paras: Paragraph[], maxChars: number): Paragraph[][] {
  const chunks: Paragraph[][] = [];
  let current: Paragraph[] = [];
  let size = 0;
  for (const p of paras) {
    if (current.length > 0 && size + p.text.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += p.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
