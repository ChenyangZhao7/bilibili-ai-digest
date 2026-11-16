const STAGE_LABEL: Record<string, string> = {
  parsing: "解析链接",
  fetching_meta: "读取视频信息",
  subtitle: "抓字幕",
  downloading: "下载音频",
  transcribing: "语音识别",
  summarizing: "AI 总结",
  done: "完成",
  failed: "失败",
};

const base = process.env.SMOKE_BASE ?? "http://127.0.0.1:4318";
const url = process.argv[2] ?? "BV1GJ411x7h7";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<number> {
  const started = Date.now();
  const res = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = (await res.json()) as { jobId?: string; error?: string };
  if (!res.ok || !body.jobId) {
    console.error(`提交失败：${body.error ?? res.status}`);
    return 1;
  }

  let lastStage = "";
  let reportId: string | null = null;
  const deadline = Date.now() + 15 * 60_000;

  while (Date.now() < deadline) {
    const job = (await fetch(`${base}/api/jobs/${body.jobId}`).then((r) => r.json())) as {
      status: string;
      stage: string;
      progress: number;
      error: string | null;
      reportId: string | null;
      title: string | null;
    };

    if (job.stage !== lastStage) {
      lastStage = job.stage;
      console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${STAGE_LABEL[job.stage] ?? job.stage} ${job.progress}%`);
    }

    if (job.status === "done") {
      reportId = job.reportId;
      console.log(`\n完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (reportId) {
        const report = (await fetch(`${base}/api/reports/${reportId}`).then((r) => r.json())) as {
          meta: { title: string };
          payload: { verdict: { watch: string; one_line: string } } | null;
        };
        console.log(`报告：${report.meta.title}`);
        if (report.payload) console.log(`结论：${report.payload.verdict.watch} — ${report.payload.verdict.one_line}`);
        console.log(`地址：${base}/#/r/${reportId}`);
      }
      return 0;
    }

    if (job.status === "failed") {
      console.error(`\n失败：${job.error}`);
      if (job.error && /语音识别组件|LLM key|登录/.test(job.error)) {
        console.error(`这属于还没完成的准备工作，打开 ${base}/#/settings 处理后再跑一次。`);
      }
      return 1;
    }

    await sleep(800);
  }

  console.error("超时：15 分钟还没结束");
  return 1;
}

main().then((code) => process.exit(code));
