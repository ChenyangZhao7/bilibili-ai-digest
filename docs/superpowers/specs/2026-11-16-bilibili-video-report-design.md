# B站视频 → 文字报告 工具 设计文档

日期：2026-11-16
状态：待批准

## 1. 意图与原因

用户不想看视频，但视频里的信息有用。目标：**粘贴一个 B站链接，几十秒后得到一份可读的报告**，读完就知道视频讲了什么、值不值得看、哪几段值得点回去看。

用户原话：「我一般会给你有字幕的视频其实」——所以字幕路径是主路，语音识别只是保险丝。

成功的样子：用户刷到一个 40 分钟的视频，粘链接，去倒杯水，回来读 1 分钟的报告，决定不看。

## 2. 目标

- G1 粘贴链接即可出报告，不要求用户手动复制字幕或时间轴
- G2 有字幕的视频 10 秒内出报告（不含 LLM 生成时间，通常 20～60 秒）
- G3 报告含可点击时间戳，能把用户送回视频对应位置
- G4 无字幕时自动走本机语音识别，报告注明「文字来自语音识别，可能有错」
- G5 历史报告本地留存，可搜索、可回看、可删除
- G6 key、cookie、报告全部只存本机，不上传任何第三方（除字幕文本发给用户自己配置的 LLM）
- G7 登录态用扫码获取，不要求用户开 DevTools 复制 cookie

## 3. 非目标（v1 明确不做）

- N1 不做 YouTube / 抖音 / 小红书。架构留出「平台适配器」接口，v1 只实现 B站
- N2 不做自动订阅、定时抓取、批量导入
- N3 不做弹幕分析、评论分析
- N4 不做账号体系、多用户、部署到公网；**服务只绑定 127.0.0.1，不对局域网开放**（用户已确认只在本机看）
- N5 不做移动端适配（只保证窗口拉窄时能读）
- N6 不做视频画面理解（不抽帧、不看画面里的 PPT）

## 4. 反目标（技术上行但算失败）

- A1 用户还得自己打开 B站找字幕、复制粘贴 → 不算成功
- A2 报告只是把字幕原文丢给 LLM 说「总结一下」，出来一堆正确的废话 → 报告必须回答「讲了什么 + 值不值得看 + 哪几段值得看」
- A3 失败时只说「出错了」 → 每种失败必须给出下一步动作（例如「登录已过期，点这里重新填 cookie」）
- A4 为了全自动偷偷装 CUDA 驱动、改系统环境 → 所有安装动作都要用户点按钮并说明体积和用途

## 5. 约束（本机实测结果，2026-11-16）

| 事实 | 影响 |
|---|---|
| Node v24.22.0，Python 3.14.7 | 用 Node 实现；不用 Python（3.14 太新，ASR 轮子不全） |
| 无 ffmpeg、无 yt-dlp | 用 npm `ffmpeg-static`（registry 可达，已验证）；不依赖 yt-dlp |
| `node:sqlite` 可用 | 用它存库，不引入 better-sqlite3 |
| `api.bilibili.com/x/web-interface/view` 匿名可用 | 元数据（标题、cid、时长、UP主）无需登录 |
| `x/player/playurl?fnval=16` 匿名可用，返回 dash 音频流（30216/30232/30280） | 兜底 ASR 可以直接下音频，不需要登录 |
| `x/player/v2` 匿名返回 `subtitles: []`（热门榜 6 个视频全为空） | **字幕必须带 SESSDATA cookie**；这是主路的前置条件 |
| github.com api 可达；github release 大文件下载时快时拒 | ASR 二进制下载要可重试、可手动放置 |
| huggingface.co 不通，hf-mirror.com 首页可达 | 模型必须走 hf-mirror 镜像 |
| GPU：RTX 3060 Laptop 6GB | whisper medium 走 CUDA 可行；CPU 版作为保底 |
| 国内网络、B站有风控（-352/-412） | 请求要限速、带 UA/Referer、失败可读提示 |
| `passport.bilibili.com/x/passport-login/web/qrcode/generate` 与 `.../poll` 匿名可用（实测返回 `86101 未扫码`） | 扫码登录可行；登录成功时 cookie 在 poll 响应的 `Set-Cookie` 里，用 `getSetCookie()` 取 |

## 6. 方案取舍

**A. 只走字幕接口**：几秒、免费、质量最好。但只能处理有字幕的视频，且强依赖 cookie 有效期。
**B. 只走语音识别**：任何视频都行、不依赖登录。但每个视频 2～5 分钟，吃 GPU，BGM/多人抢话会错，安装包 1.5GB。
**C. A 优先，失败落 B（用户已选）**：常用路径几秒出结果，慢路径只在需要时触发。代价是两条路径加一套降级判断。

选 C。理由是用户说「一般给有字幕的视频」，说明 90% 的调用落在快路上；但一旦没有字幕就彻底失败，体验会很糟，所以需要保险丝。A 单独不够，B 单独太慢。

## 7. 架构

```
浏览器（单页，无构建步骤）
   │  POST /api/analyze {url}
   ▼
Express 5 服务（Node 24，直接跑 .ts，type-stripping）
   │
   ├─ Job 队列（内存 + sqlite 状态，同一时刻 1 个任务）
   │    0. 登录态：扫码获取 cookie（模块见 7.5），缺失/过期时任务降级
   │    1. 解析 URL → bvid / av / cid(p)
   │    2. view API → 标题、时长、UP主、cid
   │    3. 字幕路径：player/v2(带 cookie) → subtitle_url → 拉 json → 合并成带时间戳的段落
   │        └ 失败/为空 → 4
   │    4. ASR 路径：playurl → 下载音频 → ffmpeg-static 转 16k 单声道 wav → whisper-cli
   │    5. LLM：分块（必要时）→ 结构化 JSON → 校验
   │    6. 存 sqlite，返回报告 id
   │
   ├─ node:sqlite（data/app.db）
   ├─ 本机组件目录（bin/ whisper.cpp，models/ ggml-*.bin）
   └─ DeepSeek / 任意 OpenAI 兼容 API
```

### 7.1 技术选型（builder 可直接照做）

- **语言/运行时**：Node 24 + TypeScript，`.ts` 直接运行（`node --experimental-strip-types`，Node 24 默认开启类型擦除）。不做打包、不做 tsc 构建。约束：只用可擦除语法（无 enum、无 namespace、无参数属性）。
- **服务端**：Express 5。路由 + 静态文件，够用。
- **数据库**：`node:sqlite` 的 `DatabaseSync`。WAL 模式。
- **前端**：`public/index.html` + `public/app.js` + `public/style.css`，原生 JS，无打包。Markdown 渲染用 `marked`（npm），报告主体用结构化 JSON 自行渲染，只有长文本字段走 marked。
- **依赖**：express、marked、qrcode、ffmpeg-static。就这四个，不加 devDependency。避免依赖地狱。
- **配置**：全部存 sqlite `settings` 表（cookie、LLM base/model/key）。不写 .env，不写 config.json，避免用户找不到。
- **启动方式**：`start.bat` 双击启动（内部 `node --experimental-strip-types server.ts`），服务就绪后自动打开默认浏览器；已有实例在跑时直接打开浏览器而不是报端口占用。不做开机自启（v1 不做）。控制台窗口最小化标题写明「关掉这个窗口 = 关闭服务」。

### 7.2 数据模型

```sql
videos(bvid TEXT, cid INTEGER, title, owner, duration, cover, source TEXT,   -- 'subtitle' | 'asr'
       transcript_json TEXT, transcript_text TEXT, fetched_at, PRIMARY KEY(bvid, cid))
reports(id TEXT PK, bvid, cid, model, prompt_version TEXT, payload_json TEXT, markdown TEXT,
        tokens_in, tokens_out, created_at)
jobs(id TEXT PK, url, bvid, cid, status TEXT, stage TEXT, progress INTEGER, error TEXT,
     report_id TEXT, created_at, updated_at)
settings(key TEXT PK, value TEXT)
```

`source` 与 `prompt_version` 必须落库：报告要标注「文字来自语音识别」，重新生成时能判断是否需要升级。

### 7.3 关键实现细节

**URL 解析**：接受 `bilibili.com/video/BVxxxx`、`/video/av123`、`m.bilibili.com/...`、`b23.tv/xxxx`（短链需跟随 302 拿最终 URL）、纯 `BVxxxx` 或 `av123`。`?p=N` 映射到 `pages[N-1].cid`，默认第 1P。解析失败返回具体提示，不要静默当成第 1P。

**字幕路径**：
1. 从 settings 取 cookie（扫码登录写入的 `SESSDATA` + `bili_jct` + `DedeUserID` + `buvid3`），拼成 `Cookie` 头。只发这几个字段，不发 `buvid4`、`_uuid` 等指纹类 cookie。
2. `GET api.bilibili.com/x/player/v2?bvid=&cid=` 带 `Cookie`、`Referer: https://www.bilibili.com/`、桌面 UA。
3. `data.subtitle.subtitles` 里优先 `lan === 'ai-zh'`，其次任何 `zh`，再次第一条。
4. `subtitle_url` 是 `//` 开头，补 `https:`。拉取同样要 Referer。
5. 返回 `body[{from,to,content}]`：按 2.5 秒内或标点边界合并成 8～20 字的句子，再合并成约 200～400 字、带起止时间的段落，供 LLM 打时间戳。
6. 空字幕 / `code === -101`（未登录）/ `-352`（风控）→ 分别返回不同错误，并进入 ASR 路径（`-352` 不重试字幕，直接 ASR；`-101` 先提示登录过期再走 ASR）。

**ASR 路径**：
1. `playurl?fnval=16` 取 `dash.audio` 里 bandwidth 最高的流，下载（必须带 Referer，否则 403）。
2. `ffmpeg-static` → `-ar 16000 -ac 1 -c:a pcm_s16le`。
3. 选二进制：优先 `bin/whisper-cublas-12.4` + `-m models/ggml-medium.bin`；CUDA 初始化失败自动回退 `bin/whisper-bin-x64` + `ggml-small.bin`。检测方式：跑一次 1 秒静音，检查退出码。
4. 参数：`-l zh -oj -ml 1 -t 8`（用 JSON 输出拿 segment 时间戳），`-mc 0` 关掉上下文偏移以免重复。
5. 输出 JSON 的 segments 走与字幕相同的「合并成段落」函数，保证下游只有一种输入格式。
6. 组件缺失时任务失败，`error` 写明「缺少语音识别组件（约 1.5GB）」，前端给「一键安装」按钮 → `POST /api/asr/install`，下载 whisper.cpp release（可重试 3 次，支持手动把 zip 放到 `downloads/` 目录跳过下载）与 hf-mirror 上的 ggml 模型，显示进度与体积。

**LLM 部分**：
- 接口：OpenAI 兼容 `POST {base}/chat/completions`。默认 base `https://api.deepseek.com/v1`，model `deepseek-chat`。设置页可改成任何兼容地址（含本地 ollama）。
- 输入：视频元数据 + 带时间戳段落文本。总字符 ≤ 30000 一次直出；超过则按段落边界切块（每块 ≤ 12000 字，块间重叠 1 段），逐块抽要点（保留时间戳），再汇总生成最终报告。
- 输出：**严格 JSON**（`response_format: {type: 'json_object'}`），字段：

```json
{
  "verdict": { "watch": "skip|skim|watch", "one_line": "一句话结论", "reason": "为什么" },
  "tldr": ["3～5 条最关键的结论"],
  "sections": [{ "title": "小标题", "start": 123, "end": 456, "points": ["要点"] }],
  "highlights": [{ "t": 210, "label": "这段值得看", "why": "理由" }],
  "key_terms": [{ "term": "名词", "note": "解释" }],
  "caveats": ["信息缺口或不确定处"]
}
```
- `sections.start/end` 与 `highlights.t` 必须是字幕里真实存在的时间（秒，整数）。**代码侧校验：越界的时间戳丢弃**，不要指望模型守规矩。
- JSON 解析失败：重试 1 次（把解析错误回喂）；再失败则存原始文本并把 `payload_json` 置为 `{raw: "..."}`，前端降级为显示纯文本，并提示「结构化失败，可重新生成」。
- Prompt 版本号常量 `PROMPT_VERSION`，存库，改 prompt 时可识别旧报告。

**任务与进度**：`POST /api/analyze` 立即返回 `jobId`，前端每 800ms 轮询 `GET /api/jobs/:id`。stage 为 `parsing | fetching_meta | subtitle | downloading | transcribing | summarizing | done | failed`，progress 0～100。队列同一时刻只跑 1 个任务，其余 `queued`。任务记录防重复：同 bvid+cid 已完成的报告在 24 小时内直接复用（前端提示「已有报告，直接打开 / 强制重新生成」）。

**前端页面**：
- 首页：大输入框（自动从剪贴板取提示但不自动提交）、提交按钮、当前任务进度卡片、历史报告列表（标题、UP主、日期、来源标记、watch 结论色块）。
- 报告页：结论卡（skip/skim/watch 色块）→ TL;DR → 分章节（标题旁时间戳，点击 `https://www.bilibili.com/video/{bvid}?t={sec}` 新窗口）→ 值得看的片段 → 关键名词 → 折叠的完整文字稿（可复制）。
- 设置页：cookie 输入（掩码显示）+「测试登录」按钮；LLM base/model/key +「测试连接」；ASR 组件状态与安装按钮。
- 页面标签标题在完成时变为「✓ 报告已生成」，并播放一声轻提示音（用户首次操作后触发，规避自动播放限制）。不做系统通知。

### 7.4 文件结构

```
Z:\video-filter\
  package.json
  server.ts              入口：Express、路由、静态
  src/
    queue.ts             单并发任务队列 + 进度 + 失败重试
    auth.ts              扫码登录、cookie 读写、nav 校验
    bilibili.ts          URL 解析、元数据、字幕、音频地址
    subtitle.ts          合并/分段（字幕与 ASR 共用）
    asr.ts               下载音频、ffmpeg、whisper 调用、组件安装
    llm.ts               分块、调用、校验、降级
    db.ts                sqlite 建表与查询
    settings.ts          读写配置（key 掩码）
  public/                index.html / app.js / style.css
  bin/ models/ downloads/ 运行时组件（gitignore）
  data/app.db
  docs/superpowers/specs/
```

### 7.5 扫码登录（src/auth.ts）

1. `GET passport.bilibili.com/x/passport-login/web/qrcode/generate` → `{ url, qrcode_key }`。用 npm `qrcode` 把 `url` 渲染成 PNG，直接 `data:image/png;base64` 返回前端，不落盘。
2. 前端展示二维码 + 轮询 `GET /api/auth/qr/:key`，服务端转发 `.../qrcode/poll?qrcode_key=`。
3. 内层 `data.code`：`86101` 未扫码 / `86090` 已扫码未确认 / `0` 成功 / `86038` 已失效。前端按状态换文案，二维码 180 秒过期后自动刷新一张。
4. 成功时从 poll 响应 `headers.getSetCookie()` 里取 `SESSDATA`、`bili_jct`、`DedeUserID`，加上一次 `GET api.bilibili.com/x/web-interface/nav` 拿到的 `buvid3`，写入 settings。
5. 登录后立即调 `nav` 校验：`data.isLogin` 为真才算成功，并记下 `uname` 显示在设置页「已登录：xxx」。
6. 设置页保留一个「手动填 SESSDATA」的折叠项，作为扫码接口哪天挂掉时的逃生口。
7. `-101`（登录失效）时：任务提示 + 设置页展示二维码，扫完点「重试」，从已保存的字幕或音频继续，不重头再来。

## 8. 错误与边界（都要有明确文案）

| 情况 | 行为 |
|---|---|
| 链接不合法 | 立即提示「认不出这个链接，支持 BV号 / av号 / b站视频页 / b23.tv」 |
| 视频不存在/已删/地区限制 | 显示 B站原始 message |
| 无 cookies / 未登录 | 显示「扫码登录 B站（10 秒）」，同时**不阻塞**地开始 ASR 兜底；登录完成后可点「重试」走快路 |
| cookie 过期 (-101) | 同上：设置页弹出二维码，扫完点「重试」从已存产物继续 |
| 风控 (-352/-412) | 提示「B站限流，稍等 1 分钟」，自动 3 次退避重试，仍失败则走 ASR |
| 视频无字幕 | 静默走 ASR，并在报告顶部标注来源 |
| 直播回放/番剧/付费 | 明确「暂不支持番剧与直播回放」 |
| ASR 组件未装 | 失败卡片 + 一键安装按钮（注明体积） |
| LLM key 未配置 | 任务在 summarizing 前失败，提示去设置；**字幕已入库，配好 key 后可「只重新总结」不重抓** |
| LLM 超时/限流 | 3 次指数退避；超时 120s |
| 超长视频（>3 小时） | **只警告不阻塞**：提交后立即开始，报告页顶部提示预计耗时与约多少钱；不做需要人确认的中间态（避免队列卡在等人） |
| 组件装好 / 登录完成后 | 失败任务保留全部已抓产物，卡片上给「重试」，从断点继续；「失败」不是终态，但也不自动跑，避免后台偷偷烧钱 |
| 历史搜索 | v1 用 `LIKE` 匹配标题、UP 主、报告文本；不建 FTS5 索引（本地量级够用，省掉索引维护） |

## 9. 隐私

- cookie、API key 存本机 sqlite，前端只显示掩码；日志中禁止出现完整 cookie/key（统一 `maskSecrets()` 过滤）。
- 唯一外发内容：字幕文本 → 用户配置的 LLM 端点。设置页写明这句话。
- `data/`、`bin/`、`models/` 进 `.gitignore`。

## 10. 留给 builder 决定的

- 具体 UI 配色与排版细节（只要求：深色、信息密度高、时间戳醒目、窗口拉窄能读）
- 页面路由用 hash 还是 query（建议 hash，免去服务端回退配置）
- whisper 参数微调、段落合并的具体阈值
- 是否给 job 加 SSE（轮询够用就不加）
- 测试策略与 fixture：至少一个真实有字幕的 BV 号做端到端冒烟，其余用保存好的 JSON fixture 单测分段与校验逻辑

## 11. 已定但不显然的取舍（供 builder 对齐）

- **只绑 127.0.0.1**：不做鉴权、不做局域网访问、不做手机端。换局域网要加 token 门禁，属于新需求。
- **扫码登录是主路径**，手动填 cookie 只作逃生口。二维码 180 秒过期，自动刷新。
- **LLM 按「用户首次运行时粘一个 key」规划**，默认 DeepSeek；本地 ollama 只是同一个接口的另一种配置，不做模型下载与显存管理。
- **启动方式**：双击 `start.bat` + 自动开浏览器；不做开机自启、不做后台服务、不做托盘。
- **失败可重试但不自动重试**：所有中间产物（字幕 JSON、音频、文字稿、分块摘要）落盘/入库，重试时跳过已完成的阶段。
