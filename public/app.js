const view = document.getElementById("view");
const toasts = document.getElementById("toasts");
const loginDot = document.getElementById("login-dot");

const STAGE_LABEL = {
  parsing: "解析链接",
  fetching_meta: "读取视频信息",
  subtitle: "抓字幕",
  downloading: "下载音频",
  transcribing: "语音识别（这一步最慢）",
  summarizing: "AI 总结",
  done: "完成",
  failed: "失败",
};

const WATCH_LABEL = { skip: "不看", skim: "略看", watch: "值得看" };

let pollTimer = null;
let currentJobId = null;
let audioCtx = null;
let audioUnlocked = false;

document.addEventListener(
  "pointerdown",
  () => {
    audioUnlocked = true;
    if (!audioCtx) {
      try {
        audioCtx = new AudioContext();
      } catch {
        audioCtx = null;
      }
    }
  },
  { once: true },
);

function ding() {
  if (!audioUnlocked || !audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 880;
  osc.type = "sine";
  gain.gain.value = 0.04;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.12);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "href") node.setAttribute("href", v);
    else if (k === "target") node.setAttribute("target", v);
    else if (k === "rel") node.setAttribute("rel", v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message) {
  const node = el("div", { class: "toast", text: message });
  toasts.append(node);
  setTimeout(() => node.remove(), 4200);
}

function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function watchBadge(watch) {
  return el("span", { class: `badge ${watch || "skip"}`, text: WATCH_LABEL[watch] || "未知" });
}

function clearPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  currentJobId = null;
}

function stopAudioTitle() {
  if (document.title.startsWith("✓")) document.title = "视频报告";
}

// ---------------- 路由 ----------------

function route() {
  stopAudioTitle();
  const hash = location.hash || "#/";
  const reportMatch = hash.match(/^#\/r\/([\w-]+)$/);
  document.querySelectorAll(".topbar nav a").forEach((a) => a.classList.remove("active"));
  const homeLink = document.querySelector('.topbar nav a[href="#/"]');
  const settingsLink = document.querySelector('.topbar nav a[href="#/settings"]');

  if (reportMatch) {
    renderReport(reportMatch[1]);
    return;
  }
  if (hash === "#/settings") {
    settingsLink?.classList.add("active");
    renderSettings();
    return;
  }
  homeLink?.classList.add("active");
  renderHome();
}

window.addEventListener("hashchange", route);

// ---------------- 首页 ----------------

async function renderHome() {
  view.replaceChildren(
    el(
      "section",
      { class: "hero" },
      el("h1", { text: "粘个链接，读报告" }),
      el("p", {
        class: "muted",
        text: "有字幕的视频几秒出文字；没有字幕的自动转语音识别，慢一些但也能出。",
      }),
      el(
        "form",
        {
          class: "submit-form",
          onsubmit: (e) => {
            e.preventDefault();
            submitLink();
          },
        },
        el("input", {
          id: "url-input",
          type: "text",
          placeholder: "粘贴 B站 链接、BV号或 av号",
          autocomplete: "off",
          autofocus: "autofocus",
        }),
        el("button", { type: "submit", text: "生成报告" }),
      ),
      el(
        "label",
        { class: "check" },
        el("input", { type: "checkbox", id: "force-check" }),
        "忽略已有报告，强制重新生成",
      ),
    ),
    el("div", { id: "job-slot" }),
    el(
      "section",
      {},
      el(
        "div",
        { class: "list-head" },
        el("h2", { text: "历史报告" }),
        el("input", { id: "search-input", type: "text", placeholder: "搜标题、UP主或报告内容" }),
      ),
      el("div", { id: "history", class: "muted", text: "加载中…" }),
    ),
  );

  const search = document.getElementById("search-input");
  let searchTimer = null;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadHistory(search.value.trim()), 250);
  });

  await Promise.all([loadHistory(""), refreshLoginDot(), resumeRunningJobs()]);
}

async function refreshLoginDot() {
  try {
    const s = await api("/api/auth/status");
    if (s.isLogin) {
      loginDot.classList.add("on");
      loginDot.textContent = s.uname ? `已登录 ${s.uname}` : "已登录";
    } else {
      loginDot.classList.remove("on");
      loginDot.textContent = "未登录";
    }
  } catch {
    loginDot.textContent = "未登录";
  }
}

async function loadHistory(q) {
  const box = document.getElementById("history");
  if (!box) return;
  try {
    const data = await api(`/api/reports?q=${encodeURIComponent(q)}`);
    box.className = "";
    if (data.items.length === 0) {
      box.className = "muted";
      box.textContent = q ? "没有匹配的报告" : "还没有报告，粘一个链接试试";
      return;
    }
    box.replaceChildren(
      ...data.items.map((item) =>
        el(
          "a",
          { class: "report-item", href: `#/r/${item.id}` },
          watchBadge(item.verdict?.watch ?? "skip"),
          el("span", { class: "title", text: item.title || item.bvid }),
          el("span", { class: "tag", text: item.source === "asr" ? "语音识别" : "字幕" }),
          el("span", {
            class: "meta",
            text: `${item.owner || ""} · ${new Date(item.createdAt).toLocaleDateString("zh-CN")}`,
          }),
        ),
      ),
    );
  } catch (err) {
    box.className = "muted";
    box.textContent = err.message;
  }
}

async function resumeRunningJobs() {
  try {
    const data = await api("/api/jobs?running=1");
    if (data.items.length > 0) startPolling(data.items[0].id);
  } catch {
    // 忽略
  }
}

async function submitLink() {
  const input = document.getElementById("url-input");
  const force = document.getElementById("force-check")?.checked ?? false;
  const url = (input?.value ?? "").trim();
  if (!url) {
    toast("先粘一个链接");
    return;
  }
  try {
    const { jobId } = await api("/api/analyze", { method: "POST", body: { url, force } });
    startPolling(jobId);
  } catch (err) {
    showError(err.message, []);
  }
}

function startPolling(jobId) {
  clearPolling();
  currentJobId = jobId;
  const startedAt = Date.now();

  const tick = async () => {
    if (currentJobId !== jobId) return;
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
    } catch (err) {
      showError(err.message, []);
      return;
    }
    renderJob(job, startedAt);

    if (job.status === "done" && job.reportId) {
      clearPolling();
      document.title = "✓ 报告已生成";
      ding();
      location.hash = `#/r/${job.reportId}`;
      return;
    }
    if (job.status === "failed") {
      clearPolling();
      showJobError(job);
      return;
    }
    pollTimer = setTimeout(tick, 800);
  };

  void tick();
}

function renderJob(job, startedAt) {
  const slot = document.getElementById("job-slot");
  if (!slot) return;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const label = STAGE_LABEL[job.stage] || job.stage;
  slot.replaceChildren(
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row" },
        el("h3", { text: job.title || "正在处理" }),
        el("span", { class: "muted", text: `${label} · ${elapsed}s` }),
      ),
      el("div", { class: "progress" }, el("i", { style: `width:${Math.max(3, job.progress)}%` })),
      el("p", {
        class: "muted",
        text:
          job.stage === "transcribing"
            ? "没有字幕，正在本机转语音，20 分钟的视频大概 2～4 分钟"
            : job.stage === "subtitle"
              ? "有字幕就走快路，几秒就好"
              : "",
      }),
    ),
  );
}

function showJobError(job) {
  const message = job.error || "任务失败";
  const actions = [];
  if (/登录|SESSDATA|cookie|LLM key|API key|鉴权|语音识别组件/i.test(message)) {
    actions.push(el("button", { text: "去设置", onclick: () => (location.hash = "#/settings") }));
  }
  actions.push(
    el("button", {
      class: "ghost",
      text: "重试",
      onclick: async () => {
        try {
          await api(`/api/jobs/${job.id}/retry`, { method: "POST" });
          startPolling(job.id);
        } catch (err) {
          toast(err.message);
        }
      },
    }),
  );
  showError(message, actions);
}

function showError(message, actions) {
  const slot = document.getElementById("job-slot") || view;
  const card = el(
    "div",
    { class: "card error" },
    el("h3", { text: "没成功" }),
    el("p", { text: message }),
    el("div", { class: "actions" }, ...actions),
  );
  slot.replaceChildren(card);
}

// ---------------- 报告页 ----------------

async function renderReport(id) {
  view.className = "";
  view.textContent = "加载中…";
  let data;
  try {
    data = await api(`/api/reports/${id}`);
  } catch (err) {
    view.replaceChildren(el("div", { class: "card error" }, el("p", { text: err.message })));
    return;
  }

  const payload = data.payload || {
    verdict: { watch: "skim", one_line: "报告内容不可用", reason: "" },
    tldr: [],
    sections: [],
    highlights: [],
    key_terms: [],
    caveats: [],
  };
  const meta = data.meta || {};
  const videoUrl = (sec) => `https://www.bilibili.com/video/${data.bvid}?t=${Math.floor(sec)}`;

  const children = [];

  children.push(
    el(
      "div",
      { class: "report-head" },
      watchBadge(payload.verdict.watch),
      el("h1", { text: meta.title || data.meta?.title || "未命名视频" }),
      el("p", { class: "one-line", text: payload.verdict.one_line || "" }),
      payload.verdict.reason ? el("p", { class: "reason", text: payload.verdict.reason }) : null,
      el(
        "div",
        { class: "actions" },
        el("a", {
          class: "tag",
          href: `https://www.bilibili.com/video/${data.bvid}`,
          target: "_blank",
          rel: "noreferrer",
          text: "打开 B站",
        }),
        el("span", { class: "tag", text: meta.source === "asr" ? "文字来自语音识别" : "文字来自字幕" }),
        el("button", {
          class: "ghost",
          text: "重新生成",
          onclick: async () => {
            try {
              const { jobId } = await api("/api/analyze", {
                method: "POST",
                body: { url: `https://www.bilibili.com/video/${data.bvid}`, force: true },
              });
              location.hash = "#/";
              startPolling(jobId);
            } catch (err) {
              toast(err.message);
            }
          },
        }),
        el("button", {
          class: "danger",
          text: "删除",
          onclick: async () => {
            if (!confirm("删掉这份报告？文字稿会保留，重新生成不用重新抓。")) return;
            try {
              await api(`/api/reports/${data.id}`, { method: "DELETE" });
              toast("已删除");
              location.hash = "#/";
            } catch (err) {
              toast(err.message);
            }
          },
        }),
      ),
    ),
  );

  if (data.degraded) {
    children.push(el("div", { class: "degraded", text: "结构化失败：这条报告是降级生成的，内容可能不完整。可以点「重新生成」再试一次。" }));
  }
  if (Number(meta.duration) > 3 * 3600) {
    const mins = Math.ceil((Number(meta.duration) / 60) * 0.15);
    children.push(
      el("div", {
        class: "warn-bar",
        text: `这是个超长视频（${Math.round(Number(meta.duration) / 60)} 分钟）。如果走了语音识别，大概要等 ${mins} 分钟。`,
      }),
    );
  }

  if (payload.tldr.length > 0) {
    children.push(el("h2", { class: "block-title", text: "一句话看完" }));
    children.push(
      el(
        "ul",
        { class: "points" },
        ...payload.tldr.map((t) => el("li", { text: t })),
      ),
    );
  }

  if (payload.sections.length > 0) {
    children.push(el("h2", { class: "block-title", text: "分章节" }));
    for (const section of payload.sections) {
      children.push(
        el(
          "div",
          { class: "section-item" },
          el(
            "h3",
            {},
            section.title,
            el("a", {
              class: "time-chip",
              href: videoUrl(section.start),
              target: "_blank",
              rel: "noreferrer",
              text: clock(section.start),
            }),
          ),
          el(
            "ul",
            { class: "points" },
            ...section.points.map((p) => el("li", { text: p })),
          ),
        ),
      );
    }
  }

  if (payload.highlights.length > 0) {
    children.push(el("h2", { class: "block-title", text: "值得点回去看的片段" }));
    for (const h of payload.highlights) {
      children.push(
        el(
          "div",
          { class: "highlight-item" },
          el("a", { class: "time-chip", href: videoUrl(h.t), target: "_blank", rel: "noreferrer", text: clock(h.t) }),
          el("span", { text: h.label }),
          el("span", { class: "why", text: h.why || "" }),
        ),
      );
    }
  }

  if (payload.key_terms.length > 0) {
    children.push(el("h2", { class: "block-title", text: "关键名词" }));
    children.push(
      el(
        "dl",
        { class: "term-grid" },
        ...payload.key_terms.flatMap((k) => [el("dt", { text: k.term }), el("dd", { text: k.note })]),
      ),
    );
  }

  if (payload.caveats.length > 0) {
    children.push(el("h2", { class: "block-title", text: "需要注意" }));
    children.push(
      el(
        "ul",
        { class: "points" },
        ...payload.caveats.map((c) => el("li", { text: c })),
      ),
    );
  }

  if (data.transcript) {
    children.push(
      el(
        "details",
        {},
        el("summary", { text: "完整文字稿（复制 / 校对）" }),
        el("div", { class: "transcript", text: data.transcript }),
        el("button", {
          class: "ghost",
          text: "复制全部",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(data.transcript);
              toast("已复制");
            } catch {
              toast("复制失败，手动选中复制");
            }
          },
        }),
      ),
    );
  }

  view.replaceChildren(...children);
}

// ---------------- 设置页 ----------------

async function renderSettings() {
  view.className = "settings";
  view.replaceChildren(el("p", { class: "muted", text: "加载中…" }));

  const [status, settings, asr, install] = await Promise.all([
    api("/api/auth/status").catch(() => ({ isLogin: false })),
    api("/api/settings").catch(() => ({})),
    api("/api/asr/status").catch(() => ({ ready: false, missing: [] })),
    api("/api/asr/install").catch(() => ({ running: false })),
  ]);

  view.replaceChildren(
    loginSection(status),
    llmSection(settings),
    asrSection(asr, install),
    el(
      "p",
      { class: "muted" },
      "所有数据都在这台电脑上（data/app.db）。只有文字稿会发给你配置的 AI 接口。",
    ),
  );
}

function loginSection(status) {
  const statusLine = el("p", {
    class: status.isLogin ? "" : "muted",
    text: status.isLogin ? `已登录：${status.uname || "B站账号"}` : "还没登录。扫码登录后才能抓字幕（快速路径）。",
  });
  const qrSlot = el("div", {});

  const startQr = async () => {
    qrSlot.replaceChildren(el("p", { class: "muted", text: "正在生成二维码…" }));
    try {
      const qr = await api("/api/auth/qr", { method: "POST", body: {} });
      const img = el("img", { src: qr.pngDataUrl, alt: "B站登录二维码" });
      const hint = el("p", { class: "muted", text: "用手机 B站扫码，二维码 3 分钟内有效" });
      qrSlot.replaceChildren(el("div", { class: "qr-box" }, img, el("div", {}, hint)));

      const poll = async () => {
        try {
          const r = await api(`/api/auth/qr/${qr.key}`);
          if (r.state === "confirmed") {
            qrSlot.replaceChildren(el("p", { text: `登录成功：${r.uname || ""}` }));
            toast("登录成功");
            refreshLoginDot();
            return;
          }
          if (r.state === "scanned") hint.textContent = "已扫码，请在手机上点确认";
          if (r.state === "expired" || r.state === "declined") {
            qrSlot.replaceChildren(el("p", { class: "muted", text: "二维码失效了，重新生成…" }));
            setTimeout(startQr, 800);
            return;
          }
          setTimeout(poll, 2000);
        } catch {
          setTimeout(poll, 3000);
        }
      };
      setTimeout(poll, 2000);
    } catch (err) {
      qrSlot.replaceChildren(el("p", { class: "muted", text: err.message }));
    }
  };

  const manualInput = el("input", { type: "password", placeholder: "粘贴 SESSDATA", id: "manual-sessdata" });

  return el(
    "section",
    {},
    el("h2", { text: "B站 登录" }),
    statusLine,
    el(
      "div",
      { class: "actions" },
      el("button", {
        text: status.isLogin ? "重新扫码" : "扫码登录",
        onclick: () => void startQr(),
      }),
    ),
    qrSlot,
    el(
      "details",
      {},
      el("summary", { text: "扫码不可用时，手动填 SESSDATA" }),
      el(
        "div",
        { class: "field" },
        el("label", { text: "浏览器登录 B站 → F12 → Application → Cookies → 复制 SESSDATA" }),
        manualInput,
        el("button", {
          class: "ghost",
          text: "保存并校验",
          onclick: async () => {
            try {
              const r = await api("/api/auth/manual", {
                method: "POST",
                body: { sessdata: manualInput.value.trim() },
              });
              toast(`已登录：${r.uname || ""}`);
              refreshLoginDot();
            } catch (err) {
              toast(err.message);
            }
          },
        }),
      ),
    ),
  );
}

function llmSection(settings) {
  const baseInput = el("input", { type: "text", value: settings.llmBaseUrl || "https://api.deepseek.com/v1" });
  const modelInput = el("input", { type: "text", value: settings.llmModel || "deepseek-chat" });
  const keyInput = el("input", {
    type: "password",
    placeholder: settings.llmApiKeyMasked && settings.llmApiKeyMasked !== "***" ? `已保存 ${settings.llmApiKeyMasked}，留空不修改` : "sk-...",
  });
  const result = el("p", { class: "muted", text: "" });

  return el(
    "section",
    {},
    el("h2", { text: "AI 接口" }),
    el(
      "div",
      { class: "field" },
      el("label", { text: "接口地址（任何 OpenAI 兼容地址都行）" }),
      baseInput,
    ),
    el(
      "div",
      { class: "field" },
      el("label", { text: "模型" }),
      modelInput,
    ),
    el(
      "div",
      { class: "field" },
      el("label", { text: "API key（只存本机）" }),
      keyInput,
    ),
    el(
      "div",
      { class: "actions" },
      el("button", {
        text: "保存",
        onclick: async () => {
          try {
            await api("/api/settings/llm", {
              method: "PUT",
              body: { baseUrl: baseInput.value.trim(), model: modelInput.value.trim(), apiKey: keyInput.value.trim() },
            });
            keyInput.value = "";
            toast("已保存");
          } catch (err) {
            toast(err.message);
          }
        },
      }),
      el("button", {
        class: "ghost",
        text: "测试连接",
        onclick: async () => {
          result.textContent = "测试中…";
          const r = await api("/api/settings/llm/test", { method: "POST", body: {} }).catch((e) => ({
            ok: false,
            message: e.message,
          }));
          result.textContent = r.message;
        },
      }),
    ),
    result,
  );
}

function asrSection(asr, install) {
  const box = el("div", {});
  const renderState = (state) => {
    if (state.running) {
      const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
      box.replaceChildren(
        el("p", { class: "muted", text: `${state.stage || "安装中"} ${pct}%` }),
        el("div", { class: "progress" }, el("i", { style: `width:${Math.max(3, pct)}%` })),
        el("p", { class: "muted", text: `${Math.round(state.done / 1e6)}MB / ${Math.round(state.total / 1e6)}MB` }),
      );
    } else if (state.error) {
      box.replaceChildren(el("p", { style: "color:var(--danger)", text: state.error }));
    } else {
      box.replaceChildren();
    }
  };

  renderState(install);

  const statusText = asr.ready
    ? "已安装，没有字幕的视频可以自动转文字"
    : `未安装（缺少：${asr.missing.join("、")}）。装了才能处理没字幕的视频，约 1.5GB，下载几分钟。`;

  return el(
    "section",
    {},
    el("h2", { text: "本机语音识别（兜底）" }),
    el("p", { class: asr.ready ? "" : "muted", text: statusText }),
    el(
      "div",
      { class: "actions" },
      el("button", {
        class: "ghost",
        text: asr.ready ? "重新安装/修复" : "一键安装（约 1.5GB）",
        onclick: async () => {
          await api("/api/asr/install", { method: "POST", body: {} }).catch((e) => toast(e.message));
          const tick = async () => {
            const state = await api("/api/asr/install").catch(() => null);
            if (!state) return;
            renderState(state);
            if (state.running) setTimeout(tick, 1000);
            else if (!state.error) toast("安装完成");
          };
          setTimeout(tick, 800);
        },
      }),
    ),
    box,
  );
}

loginDot.addEventListener("click", () => {
  location.hash = "#/settings";
});

route();
