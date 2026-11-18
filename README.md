# Video Digest · bilibili-ai-digest

**English** | [中文](README.zh-CN.md)

**Paste a Bilibili link and get a readable, timestamped report in under a minute**: what it covers, whether it is worth watching, and which parts are worth jumping back into.

You do not want to spend 40 minutes on a video, but you do not want to miss what is in it. That is the whole job.

- Videos with subtitles: read from Bilibili's subtitle API in seconds.
- Videos without: download the audio and fall back to local speech recognition (one ~1.5 GB component, installed once).
- The report: a one-line verdict, sectioned key points, clips worth revisiting, key names, and the full transcript. Every timestamp links back to the original.
- Everything runs on your own machine: the server binds `127.0.0.1`, and nothing leaves it except the transcript you send to the AI endpoint you configured.

## Quick start

1. Double-click "视频报告" on the desktop, or `start.bat` in the project.
2. Open `http://127.0.0.1:4318`.
3. On first use, do two things on the settings page: **scan the QR code to log in to Bilibili** and **enter an AI key** (DeepSeek by default).
4. Back on the home page, paste a link, wait, read the report.

Optional third step: install the speech-recognition component at the bottom of the settings page. Without it the tool still works; videos with no subtitles will just point you there.

## What is in a report

| Block | Purpose |
|---|---|
| Verdict | `Skip` / `Skim` / `Worth watching` plus a one-line reason |
| In one sentence | The 3–8 most important facts and arguments |
| Sections | Grouped by content, each with clickable timestamps |
| Clips worth revisiting | 3–6 information-dense moments, each with a reason |
| Key names | People, terms and companies that appear in the video |
| Caveats | Information gaps, stance warnings, places ASR may be wrong |
| Full transcript | Collapsed, copyable, proofreadable |

The same video reuses its report for 24 hours; tick "force regenerate" to redo it.

## Everyday use

- All link forms work: `bilibili.com/video/BV...`, `b23.tv/...`, a bare `BV` id, an `av` id.
- For multi-part videos, `?p=2` analyses part 2, and timestamps in the report carry `p=2`.
- Past reports are searchable on the home page (title, uploader, body).
- The settings page can point at any OpenAI-compatible endpoint, including local Ollama.

## What it does not do

- No bangumi, live replays or courses.
- Does not look at the picture: no frame sampling, no reading text in slides, only what is said.
- No auto-subscription or batch import.
- Not exposed to the LAN (binds `127.0.0.1` only).
- No accounts.

## Stack

Node 24 (runs TypeScript directly, no build step) · Express 5 · `node:sqlite` · whisper.cpp · plain-JS single-page frontend · `node:test` with no test framework.

```
server.ts            HTTP API + static files
src/
  queue.ts           single-concurrency job queue
  pipeline.ts        fetch → segment → summarise (resumable)
  bilibili.ts        link parsing, metadata, subtitles, audio URL
  subtitle.ts        segmentation shared by subtitles and ASR
  auth.ts            QR login
  asr.ts             audio download, transcode, whisper call, CUDA→CPU fallback
  llm.ts             chunking, allow-list checks, degrades, markdown rendering
  install.ts         on-demand install of the ASR component
  db.ts / settings.ts
public/              single-page UI
docs/superpowers/    design docs and implementation plans
```

## Development

```powershell
npm start                              # start
npm test                               # 64 tests
npx tsc --noEmit                       # type check (npm run typecheck)
node scripts/smoke.ts BV1CFsE6pEqp     # end-to-end smoke test against a running server
```

## Privacy

- Bilibili cookies, the AI key and reports live in `data/app.db` (SQLite) on this machine and never enter git.
- The settings API returns masks and login state, never the cookie.
- Deleting `data/app.db` wipes every report and every setting.
- Logs and errors filter `SESSDATA`, `Bearer`, `sk-` and similar secret fragments.

## FAQ

Known issues caused by external dependencies (Bilibili's subtitle API returning the wrong subtitles, ASR component downloads, multi-part behaviour) live in [`docs/known-issues.md`](docs/known-issues.md).

**No subtitles / "login expired"**
Scan the QR code again on the settings page. With no subtitles it falls back to speech recognition: slower, but it finishes.

**"Bilibili is rate limiting"**
Wait a minute and retry. After repeated failures, take a break.

**The ASR component will not download**
GitHub and HuggingFace are unreliable from mainland China. Follow the prompt and place the files by hand: the component archive (`.zip`) in `downloads/`, the model (`ggml-medium.bin`) in `models/`, then install again; existing files are skipped.

**"The subtitles Bilibili returned do not match the video"**
Not your fault — Bilibili's AI subtitle endpoint does this: repeated requests for one video can return another video's subtitles, ad garbage, or nothing. The tool now samples several times and keeps only a copy that repeats and matches the title; if nothing trustworthy arrives it reports an error rather than inventing a report. The fix: install the ASR component (bottom of the settings page) and these videos go through audio instead.

**The recognised text has errors**
It will. Loud music, people talking over each other and dialects are hard. The report's caveats section says when text came from speech recognition.

**Where is the data**
`data/app.db`. `bin/` and `models/` are the ASR component and can be deleted.

## License

MIT
