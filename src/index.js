
// FGO 签到 Cloudflare Worker + Durable Object
// 北京时间每天随机执行一次
// Cron 只负责检查和修复 Alarm，不直接触发签到

const API = "https://api.github.com";
const SCHEDULER_NAME = "fgo-daily-checkin";

const DEFAULT_WINDOW_START = "01:05";
const DEFAULT_WINDOW_END = "01:15";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SHANGHAI_OFFSET_MS = 8 * 60 * MINUTE_MS;

export default {
  // Cron 定时检查 Alarm
  async scheduled(event, env, ctx) {
    console.log(
      "Scheduler heartbeat:",
      event.cron,
      new Date(event.scheduledTime).toISOString()
    );

    const id = env.CHECKIN_SCHEDULER.idFromName(SCHEDULER_NAME);
    const stub = env.CHECKIN_SCHEDULER.get(id);

    ctx.waitUntil(
      stub.fetch("https://scheduler.internal/ensure")
        .then(async (res) => {
          console.log("Scheduler ensure:", res.status, await res.text());
        })
        .catch((error) => {
          console.error("Scheduler heartbeat error:", error);
        })
    );
  },

  // HTTP 手动触发
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/trigger") {
      return Response.json({
        ok: true,
        usage: "GET /trigger?key=YOUR_TRIGGER_KEY",
      });
    }

    const key = (env.TRIGGER_KEY || "").trim();

    const auth = (
      request.headers.get("Authorization") || ""
    ).replace(/^Bearer\s+/i, "");

    const provided = (
      url.searchParams.get("key") ||
      request.headers.get("X-Trigger-Key") ||
      auth ||
      ""
    ).trim();

    if (!key) {
      return new Response("服务端未配置 TRIGGER_KEY", { status: 500 });
    }

    if (provided !== key) {
      return new Response("forbidden: key 不匹配", { status: 401 });
    }

    const result = await dispatch(env, "manual");

    return new Response(result.body + "\n", {
      status: result.status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  },
};

export class CheckinScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // 检查现有 Alarm 是否符合当前配置
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/ensure") {
      return new Response("not found", { status: 404 });
    }

    const now = Date.now();
    const existing = await this.state.storage.getAlarm();

    if (existing !== null) {
      const bounds = getWindowBounds(
        new Date(existing),
        this.env.WINDOW_START || DEFAULT_WINDOW_START,
        this.env.WINDOW_END || DEFAULT_WINDOW_END
      );

      // Alarm 仍在未来，且处于当前配置的时间窗口内
      if (
        existing > now &&
        existing >= bounds.start &&
        existing < bounds.end
      ) {
        return Response.json({
          ok: true,
          action: "retained",
          scheduledAt: new Date(existing).toISOString(),
        });
      }

      // 旧时间不符合新配置，删除并重新安排
      console.log(
        "Old alarm invalid, replacing:",
        new Date(existing).toISOString()
      );

      await this.state.storage.deleteAlarm();
    }

    const scheduledAt = await this.scheduleUpcoming();

    return Response.json({
      ok: true,
      action: "created_or_replaced",
      scheduledAt: new Date(scheduledAt).toISOString(),
    });
  }

  // Durable Object 自动执行
  async alarm() {
    console.log(
      "Durable Object alarm fired:",
      new Date().toISOString()
    );

    try {
      const result = await dispatch(
        this.env,
        "durable-object-alarm"
      );

      console.log("Scheduled dispatch result:", result);
    } catch (error) {
      console.error("Scheduled dispatch exception:", error);
    } finally {
      // 不论执行成功与否，安排下一天
      const nextAt = await this.scheduleTomorrow();

      console.log(
        "Next randomized run:",
        new Date(nextAt).toISOString()
      );
    }
  }

  // 安排当前或下一个可执行时间窗口
  async scheduleUpcoming() {
    const now = Date.now();

    const bounds = getWindowBounds(
      new Date(now),
      this.env.WINDOW_START || DEFAULT_WINDOW_START,
      this.env.WINDOW_END || DEFAULT_WINDOW_END
    );

    let start = bounds.start;
    let end = bounds.end;

    // 今天的窗口已经结束，安排明天
    if (now >= end) {
      start += DAY_MS;
      end += DAY_MS;
    } else if (now >= start) {
      // 当前已经进入窗口，从现在开始随机
      start = now + 1000;
    }

    return this.setRandomAlarm(start, end);
  }

  // 安排明天的随机时间
  async scheduleTomorrow() {
    const tomorrow = getWindowBounds(
      new Date(Date.now() + DAY_MS),
      this.env.WINDOW_START || DEFAULT_WINDOW_START,
      this.env.WINDOW_END || DEFAULT_WINDOW_END
    );

    return this.setRandomAlarm(
      tomorrow.start,
      tomorrow.end
    );
  }

  // 设置随机 Alarm
  async setRandomAlarm(start, endExclusive) {
    if (endExclusive <= start) {
      throw new Error("Invalid alarm time window");
    }

    const span = endExclusive - start;

    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);

    const scheduledAt = start + (bytes[0] % span);

    await this.state.storage.setAlarm(scheduledAt);

    console.log(
      "Random alarm scheduled:",
      new Date(scheduledAt).toISOString()
    );

    return scheduledAt;
  }
}

// 解析 HH:MM
function parseTime(value, name) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);

  if (!match) {
    throw new Error(`${name} must use HH:MM format`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return hours * 60 + minutes;
}

// 北京时间窗口转换成 UTC 时间戳
function getWindowBounds(date, startText, endText) {
  const startMinute = parseTime(startText, "WINDOW_START");

  let endMinute = parseTime(endText, "WINDOW_END");

  if (endMinute <= startMinute) {
    endMinute += 24 * 60;
  }

  const shanghai = new Date(
    date.getTime() + SHANGHAI_OFFSET_MS
  );

  shanghai.setUTCHours(0, 0, 0, 0);

  const shanghaiMidnightUtc =
    shanghai.getTime() - SHANGHAI_OFFSET_MS;

  return {
    start:
      shanghaiMidnightUtc + startMinute * MINUTE_MS,

    end:
      shanghaiMidnightUtc + endMinute * MINUTE_MS,
  };
}

// GitHub Actions Dispatch
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
    const msg =
      "缺少配置: 需要 REPO_OWNER / REPO_NAME / GITHUB_PAT";

    console.error(msg);

    return {
      status: 500,
      body: msg,
    };
  }

  try {
    const url =
      `${API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;

    const res = await fetch(url, {
      method: "POST",

      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fgo-cron-worker",
      },

      body: JSON.stringify({ ref }),
    });

    const responseText = await res.text();
    const ok = res.status === 204;

    console.log(
      source,
      "Dispatch:",
      ok ? "SUCCESS" : "FAILED",
      "HTTP:",
      res.status
    );

    if (!ok) {
      console.error(
        "GitHub API Error:",
        responseText.slice(0, 500)
      );
    }

    return {
      status: ok ? 200 : res.status,

      body: ok
        ? `已触发 ${owner}/${repo} ${workflow} (ref=${ref})`
        : `触发失败 HTTP ${res.status}: ${responseText.slice(0, 500)}`,
    };
  } catch (error) {
    console.error("GitHub request exception:", error);

    return {
      status: 500,
      body: `请求异常: ${error.message}`,
    };
  }
}
