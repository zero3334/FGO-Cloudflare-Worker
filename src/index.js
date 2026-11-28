// FGO 签到外部触发 Worker + Durable Object 随机定时
// 在配置的北京时间窗口内每天随机执行一次。
// 每小时 Cron 只用于确保 alarm 已设置，不会直接触发签到。

const API = "https://api.github.com";
const SCHEDULER_NAME = "fgo-daily-checkin";
const DEFAULT_WINDOW_START = "19:35";
const DEFAULT_WINDOW_END = "19:45";
const MINUTE_MS = 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * MINUTE_MS;

export default {
  async scheduled(event, env, ctx) {
    console.log("Scheduler heartbeat", event.cron, new Date(event.scheduledTime).toISOString());
    const id = env.CHECKIN_SCHEDULER.idFromName(SCHEDULER_NAME);
    const stub = env.CHECKIN_SCHEDULER.get(id);
    ctx.waitUntil(
      stub.fetch("https://scheduler.internal/ensure").then(async (res) => {
        console.log("Scheduler ensure:", res.status, await res.text());
      }).catch((error) => console.error("Scheduler heartbeat error:", error))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/trigger") {
      return Response.json({ ok: true, usage: "GET /trigger?key=YOUR_TRIGGER_KEY" });
    }

    const key = (env.TRIGGER_KEY || "").trim();
    const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const provided = (url.searchParams.get("key") || request.headers.get("X-Trigger-Key") || auth || "").trim();
    if (!key) return new Response("服务端未配置 TRIGGER_KEY", { status: 500 });
    if (provided !== key) return new Response("forbidden: key 不匹配", { status: 401 });

    const result = await dispatch(env, "manual");
    return new Response(result.body + "\n", {
      status: result.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};

export class CheckinScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ensure") return new Response("not found", { status: 404 });

    const existing = await this.state.storage.getAlarm();
    if (existing !== null) {
      return Response.json({ ok: true, scheduledAt: new Date(existing).toISOString(), retained: true });
    }

    const scheduledAt = await this.scheduleUpcoming();
    return Response.json({ ok: true, scheduledAt: new Date(scheduledAt).toISOString(), retained: false });
  }

  async alarm() {
    const now = Date.now();
    const businessDay = new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
    const lastDay = await this.state.storage.get("lastAlarmDispatchDay");
    console.log("Durable Object alarm fired:", new Date(now).toISOString(), "business day:", businessDay);

    try {
      if (lastDay === businessDay) {
        console.log("Duplicate alarm ignored for:", businessDay);
      } else {
        // Persist the day before dispatch to protect against DO alarm retries.
        await this.state.storage.put("lastAlarmDispatchDay", businessDay);
        const result = await dispatch(this.env, "durable-object-alarm");
        console.log("Scheduled dispatch result:", result);
      }
    } catch (error) {
      console.error("Scheduled dispatch exception:", error);
    } finally {
      const nextAt = await this.scheduleTomorrow();
      console.log("Next randomized run:", new Date(nextAt).toISOString());
    }
  }

  async scheduleUpcoming() {
    const now = Date.now();
    const { start: todayStart, end: todayEnd } = getWindowBounds(
      new Date(now),
      this.env.WINDOW_START || DEFAULT_WINDOW_START,
      this.env.WINDOW_END || DEFAULT_WINDOW_END
    );
    let start = todayStart;
    let end = todayEnd;

    if (now >= todayEnd) {
      start = todayStart + 24 * 60 * 60 * 1000;
      end = todayEnd + 24 * 60 * 60 * 1000;
    } else if (now >= todayStart) {
      start = now + 1000;
    }

    return this.setRandomAlarm(start, end);
  }

  async scheduleTomorrow() {
    const tomorrow = getWindowBounds(
      new Date(Date.now() + 24 * 60 * 60 * 1000),
      this.env.WINDOW_START || DEFAULT_WINDOW_START,
      this.env.WINDOW_END || DEFAULT_WINDOW_END
    );
    return this.setRandomAlarm(tomorrow.start, tomorrow.end);
  }

  async setRandomAlarm(start, endExclusive) {
    const span = Math.max(1, endExclusive - start);
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const scheduledAt = start + (bytes[0] % span);
    await this.state.storage.setAlarm(scheduledAt);
    return scheduledAt;
  }
}

function parseTime(value, name) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`${name} must use HH:MM format`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid ${name}: ${value}`);
  return hours * 60 + minutes;
}

function getWindowBounds(date, startText, endText) {
  const startMinute = parseTime(startText, "WINDOW_START");
  let endMinute = parseTime(endText, "WINDOW_END");
  if (endMinute <= startMinute) endMinute += 24 * 60;

  // Shift the UTC date by +8h to use calendar fields for China Standard Time.
  const shanghai = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  shanghai.setUTCHours(0, 0, 0, 0);
  const shanghaiMidnightUtc = shanghai.getTime() - SHANGHAI_OFFSET_MS;
  const start = shanghaiMidnightUtc + startMinute * MINUTE_MS;
  return { start, end: shanghaiMidnightUtc + endMinute * MINUTE_MS };
}

async function dispatch(env, source) {
  const owner = env.REPO_OWNER;
  const repo = env.REPO_NAME;
  const workflow = env.WORKFLOW_FILE || "checkin.yml";
  const ref = env.REF || "main";

  console.log("========== GitHub Dispatch ==========");
  console.log("Source:", source);
  console.log("Repository:", `${owner}/${repo}`);
  console.log("Workflow:", workflow);
  console.log("Branch:", ref);

  if (!owner || !repo || !env.GITHUB_PAT) {
    const msg = "缺少配置: 需要 REPO_OWNER / REPO_NAME / GITHUB_PAT";
    console.error(msg);
    return { status: 500, body: msg };
  }

  try {
    const url = `${API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fgo-cron-worker",
      },
      body: JSON.stringify({ ref }),
    });
    const responseText = await res.text();
    const ok = res.status === 204;
    console.log(source, "Dispatch:", ok ? "SUCCESS" : "FAILED", "HTTP:", res.status);
    if (!ok) console.error("GitHub API Error:", responseText.slice(0, 500));
    return {
      status: ok ? 200 : res.status,
      body: ok
        ? `已触发 ${owner}/${repo} ${workflow} (ref=${ref})`
        : `触发失败 HTTP ${res.status}: ${responseText.slice(0, 500)}`,
    };
  } catch (error) {
    console.error("GitHub request exception:", error);
    return { status: 500, body: `请求异常: ${error.message}` };
  }
}
