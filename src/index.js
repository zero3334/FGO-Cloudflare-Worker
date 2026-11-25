
const API = "https://api.github.com";

const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const WINDOW_SECONDS = 15 * 60;

// =====================================================
// Worker 入口
// =====================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 首页
    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "FGO Daily Check-in Scheduler",
        endpoints: [
          "/setup?key=YOUR_TRIGGER_KEY",
          "/trigger?key=YOUR_TRIGGER_KEY",
          "/status?key=YOUR_TRIGGER_KEY",
          "/reschedule?key=YOUR_TRIGGER_KEY"
        ]
      });
    }

    // 验证密钥
    if (
      !env.TRIGGER_KEY ||
      url.searchParams.get("key") !== env.TRIGGER_KEY
    ) {
      return new Response("forbidden", { status: 401 });
    }

    // 手动触发 GitHub Actions
    if (url.pathname === "/trigger") {
      const result = await dispatch(env, "manual");

      return Response.json(result, {
        status: result.status
      });
    }

    // 初始化每日随机任务
    if (url.pathname === "/setup") {
      return schedulerRequest(env, "/ensure");
    }

    // 查看下一次签到时间
    if (url.pathname === "/status") {
      return schedulerRequest(env, "/status");
    }

    // 重新随机生成下一次签到时间
    if (url.pathname === "/reschedule") {
      return schedulerRequest(env, "/reschedule");
    }

    return Response.json({
      ok: false,
      error: "Not Found"
    }, { status: 404 });
  }
};


// =====================================================
// Durable Objects 请求入口
// =====================================================

async function schedulerRequest(env, path) {
  if (!env.FGO_SCHEDULER) {
    return Response.json({
      ok: false,
      error: "缺少 FGO_SCHEDULER Durable Object 绑定"
    }, { status: 500 });
  }

  const id = env.FGO_SCHEDULER.idFromName("fgo-b-daily");
  const stub = env.FGO_SCHEDULER.get(id);

  return stub.fetch("https://scheduler.internal" + path);
}


// =====================================================
// Durable Objects 定时调度器
// =====================================================

export class FgoScheduler {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
  }

  // 内部 HTTP 接口
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ensure") {
      const schedule = await this.ensureSchedule();

      return Response.json({
        ok: true,
        message: "随机签到任务已初始化",
        schedule
      });
    }

    if (url.pathname === "/status") {
      const schedule = await this.storage.get("schedule");
      const lastResult = await this.storage.get("lastResult");
      const lastRunDate = await this.storage.get("lastRunDate");
      const alarm = await this.storage.getAlarm();

      return Response.json({
        ok: true,
        schedule: schedule || null,
        alarm: alarm ? new Date(alarm).toISOString() : null,
        lastRunDate: lastRunDate || null,
        lastResult: lastResult || null
      });
    }

    if (url.pathname === "/reschedule") {
      const schedule = await this.createInitialSchedule();

      return Response.json({
        ok: true,
        message: "已重新生成随机签到时间",
        schedule
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  // 确保已经存在定时任务
  async ensureSchedule() {
    const now = Date.now();

    let schedule = await this.storage.get("schedule");
    const alarm = await this.storage.getAlarm();
    const lastRunDate = await this.storage.get("lastRunDate");

    if (schedule && alarm !== null) {
      return schedule;
    }

    if (schedule) {
      if (
        schedule.timestamp > now ||
        lastRunDate !== schedule.beijingDate
      ) {
        await this.storage.setAlarm(
          Math.max(schedule.timestamp, now + 1000)
        );

        return schedule;
      }
    }

    return this.createInitialSchedule();
  }

  // 生成第一次随机时间
  async createInitialSchedule() {
    const now = Date.now();

    let parts = getBeijingParts(now);

    const start = beijingStartTimestamp(parts);
    const end = start + WINDOW_SECONDS * 1000;

    let minSeconds = 0;

    if (now >= end) {
      parts = nextBeijingDate(parts);
    } else if (now >= start) {
      minSeconds = Math.ceil((now - start) / 1000);
    }

    const schedule = makeSchedule(parts, minSeconds);

    await this.storage.put("schedule", schedule);
    await this.storage.setAlarm(schedule.timestamp);

    console.log("Next FGO check-in:", schedule);

    return schedule;
  }

  // 安排下一天的随机时间
  async scheduleNextDay(previousSchedule) {
    const [year, month, day] =
      previousSchedule.beijingDate.split("-").map(Number);

    const nextDate = nextBeijingDate({
      year,
      month,
      day
    });

    const schedule = makeSchedule(nextDate, 0);

    await this.storage.put("schedule", schedule);
    await this.storage.setAlarm(schedule.timestamp);

    console.log("Next day scheduled:", schedule);

    return schedule;
  }

  // Durable Objects Alarm 自动执行
  async alarm(alarmInfo) {
    console.log("========== FGO ALARM ==========");
    console.log("Retry:", alarmInfo?.retryCount || 0);

    const now = Date.now();

    const schedule = await this.storage.get("schedule");

    // 意外丢失任务时，重新初始化
    if (!schedule) {
      await this.createInitialSchedule();
      return;
    }

    // 如果提前唤醒，重新设置原定时间
    if (now < schedule.timestamp) {
      await this.storage.setAlarm(schedule.timestamp);
      return;
    }

    const dateKey = schedule.beijingDate;

    // 防止同一天重复触发
    const lastRunDate = await this.storage.get("lastRunDate");

    if (lastRunDate === dateKey) {
      console.log("Already executed today:", dateKey);

      await this.scheduleNextDay(schedule);
      return;
    }

    // 先记录执行日期，避免 Alarm 重试时重复触发
    await this.storage.put("lastRunDate", dateKey);

    console.log("FGO scheduled check-in:", dateKey);
    console.log("Beijing time:", schedule.beijingTime);

    // 触发 GitHub Actions
    const result = await dispatch(this.env, "cron");

    // 保存执行结果
    await this.storage.put("lastResult", {
      date: dateKey,
      executedAt: new Date().toISOString(),
      ok: result.ok,
      status: result.status,
      body: result.body
    });

    console.log("GitHub dispatch result:", result);

    // 无论成功或失败，都安排下一天
    await this.scheduleNextDay(schedule);

    console.log("========== ALARM FINISHED ==========");
  }
}


// =====================================================
// 北京时间计算
// =====================================================

function getBeijingParts(timestamp) {
  const date = new Date(timestamp + BEIJING_OFFSET);

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

// 北京时间 07:00 对应 UTC 前一天 23:00
function beijingStartTimestamp(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    -1,
    0,
    0
  );
}

// 计算下一天
function nextBeijingDate(parts) {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + 1)
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

// 生成随机数
function randomInt(max) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);

  return values[0] % max;
}

// 生成随机签到时间
function makeSchedule(parts, minSeconds = 0) {
  const remaining = WINDOW_SECONDS - minSeconds;

  if (remaining <= 0) {
    throw new Error("随机时间范围已经结束");
  }

  // 随机秒数：07:00:00 至 07:14:59
  const offset = minSeconds + randomInt(remaining);

  const timestamp =
    beijingStartTimestamp(parts) + offset * 1000;

  const dateKey = [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");

  const beijingTime = new Date(
    timestamp + BEIJING_OFFSET
  ).toISOString().slice(11, 19);

  return {
    beijingDate: dateKey,
    beijingTime,
    timestamp,
    utcTime: new Date(timestamp).toISOString()
  };
}


// =====================================================
// GitHub Actions Dispatch
// =====================================================

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
      "缺少配置: REPO_OWNER / REPO_NAME / GITHUB_PAT";

    console.error(msg);

    return {
      ok: false,
      status: 500,
      body: msg
    };
  }

  try {
    const url =
      `${API}/repos/${owner}/${repo}/actions/workflows/` +
      `${encodeURIComponent(workflow)}/dispatches`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fgo-cron-worker"
      },
      body: JSON.stringify({ ref })
    });

    const responseText = await res.text();

    const ok = res.status === 204;

    console.log(
      source,
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
      ok,
      status: ok ? 200 : res.status,
      body: ok
        ? `已触发 ${owner}/${repo} ${workflow} (ref=${ref})`
        : `触发失败 HTTP ${res.status}: ${responseText.slice(0, 500)}`
    };

  } catch (error) {
    console.error("GitHub request exception:", error);

    return {
      ok: false,
      status: 500,
      body: `请求异常: ${error.message}`
    };
  }
  }
