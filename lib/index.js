// dsh-restart-resume — DSH 干净重启后的会话自动续跑。
//
// 背景：supervisor / systemd 等进程管理器做干净重启（TERM → 正常退出）时，
// DSH 会给被打断的回合补写 `turn/end {kind:"aborted", reason:{kind:"disposed"}}`。
// 现有续跑插件（dsh-client-auto-continue、dsh-interrupted-resume 等）的主会话
// 扫描都只认 error / interrupted / max-tokens，`aborted` 一律跳过（防用户手动
// 停止被误续），因此干净重启留下的中断永远不会被自动续跑。本插件只补这一块：
//
//   - 只处理 `aborted` 且子原因 ∈ {disposed, legacy}（宿主销毁 / 遗留标记）的
//     最后一个回合；`user` / `parent` / `hook` 等人为取消绝不续。
//   - 与 dsh-client-auto-continue 无重叠：它永不碰 aborted，本插件只碰
//     aborted 的宿主销毁子类，不会双发「继续」。
//   - 两条扫描路径：① 存活 agent 注册表（ctx.agents.list()，覆盖启动即
//     物化的会话）；② 存储扫描（sessionQuery.listSessions() 枚举全部持久化
//     会话，命中后经 sessionController.resolveAgent() 物化再注入——没有这一步，
//     没被打开过的会话永远进不了注册表，消息就发不出去）。
//   - 每次进程生命周期内每个会话最多续一次；每次启动有总量上限。
//   - 纯宿主半边，无浏览器端代码；配置卡片由导出的 Config schema
//     （dsh 0.1.7+ 设置模型）自动派生到「插件 → 配置页」。
//
// API 依据 DSH 0.2.2-rc.1（ctx.agents.list / agent.followup / sessionQuery.
// listSessions / observeSession / sessionController.resolveAgent），与
// dsh-client-auto-continue 0.18.0 观察到的官方路径一致；DSH 升级后如报错
// 优先核对这几个接口。

import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";

/** 重启类取消子原因：宿主销毁（干净重启）与遗留标记。 */
const RESTART_CAUSES = new Set(["disposed", "legacy"]);
/** 人为/决策类取消子原因：绝不续跑。 */
const DECISION_CAUSES = new Set(["user", "parent", "hook"]);

const DEFAULT_PROMPT = "继续（上一轮 turn {turn} 因 dsh 重启被打断；先核实实际进度，别重做已生效的副作用操作，再接着做完）。";

/** 插件配置 schema：0.1.7+ 的设置模型从它派生「插件 → 配置页」的设置卡片。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description("总开关"),
  delayMs: z.natural().default(8000).description("启动后等多久开始首轮扫描（ms）"),
  freshMs: z.natural().default(15 * 60 * 1000).description("中断新鲜度窗口（ms），超过不翻旧账；也是轮询总时长上限"),
  pollMs: z.natural().default(3000).description("轮询间隔（ms）"),
  maxPerBoot: z.natural().default(8).description("每次启动最多自动续跑几个会话"),
  dryRun: z.boolean().default(false).description("只打日志不注入（验收用）"),
  verbose: z.boolean().default(true).description("详细日志"),
  includeSubagents: z.boolean().default(false).description("也处理子代理会话"),
  prompt: z.string().default(DEFAULT_PROMPT).description("续跑消息正文，支持 {turn} 占位符")
}).description("干净重启后的会话自动续跑");

// volatile 标记让运行中的宿主不必重启即可吃到设置页的修改。
const ConfigVolatile = Config.volatile?.() ?? Config;

function resolveConfig(config) {
  const base = config !== void 0 && config !== null && typeof config.get === "function"
    ? config.get()
    : (config ?? void 0);
  return { ...ConfigVolatile, ...(base ?? {}) };
}

function log(config, message) {
  if (config.verbose) console.info(`[restart-resume] ${message}`);
}

function snapshotSessionEvents(session) {
  if (typeof session.snapshotEvents === "function") return session.snapshotEvents();
  return session.events ?? [];
}

/** 找最后一个 turn/end 事件。 */
function lastTurnEnd(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "turn/end") return event;
  }
  return void 0;
}

/**
 * 会话是否已被取代：最后一条 turn/end 之后又出现了新的 turn/start，
 * 或用户自己发过消息。
 */
function superseded(events, lastEnd) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.seq <= lastEnd.seq) break;
    if (event.type === "turn/start") return true;
    if (event.type === "user/message" && event.data?.source?.kind === "user") return true;
  }
  return false;
}

/** 事件序列是否满足「被干净重启打断」的判定；返回 turn 编号或 undefined。 */
function interruptedTurn(events, cfg) {
  const end = lastTurnEnd(events);
  if (end === void 0) return void 0;
  const reason = end.data?.reason;
  if (reason?.kind !== "aborted") return void 0;
  const cause = reason.reason?.kind;
  if (typeof cause !== "string" || DECISION_CAUSES.has(cause) || !RESTART_CAUSES.has(cause)) return void 0;
  if (end.time < Date.now() - cfg.freshMs) return void 0;   // 太久以前的不翻旧账
  if (superseded(events, end)) return void 0;               // 中断后已有新回合或用户消息
  return { turn: end.data?.turn, cause, at: end.time };
}

function fillTemplate(template, ctx) {
  return template.replace(/\{turn\}/g, ctx.turn !== void 0 ? String(ctx.turn) : "");
}

/** 带超时的存储读取（照搬 auto-continue 的 5s 上限模式）。 */
async function readStored(ctx, run, deadline) {
  const timeout = Math.max(1000, Math.min(5000, deadline - Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function apply(ctx, config) {
  const getConfig = () => resolveConfig(config);

  ctx.inject(["agents"], (agentsCtx) => {
    const agents = agentsCtx.agents;
    const seen = new WeakSet();      // 处理过的 session 对象（每个只裁决一次）
    const resumed = new Set();       // 本次启动已注入续跑的会话 id
    const sweptIds = new Set();      // 存储扫描已裁决的会话 id
    const sweepFailures = new Map(); // 存储会话连续失败次数
    let sent = 0;
    let stopped = false;
    let timer;
    let sweepAnnounced = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== void 0) clearTimeout(timer);
      timer = void 0;
    };
    ctx.effect(() => stop);

    const buildMessage = (cfg, turn) => ({
      role: "user",
      id: randomUUID(),
      content: [{ type: "text", text: fillTemplate(cfg.prompt, { turn }) }],
      source: { kind: "user" }
    });

    const deliver = (cfg, sessionId, info) => {
      const agent = agents.get(sessionId);
      if (agent === void 0) return false;
      if (cfg.dryRun) {
        log(cfg, `dry-run: 命中 ${sessionId}(turn ${info.turn}, ${info.cause}, ${Math.round((Date.now() - info.at) / 1000)}s 前)`);
        return false;
      }
      try {
        agent.followup(buildMessage(cfg, info.turn));
      } catch (error) {
        console.error(`[restart-resume] 注入续跑消息失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      resumed.add(sessionId);
      sent += 1;
      log(cfg, `已注入续跑消息 -> ${sessionId}(turn ${info.turn}, ${info.cause}, ${Math.round((Date.now() - info.at) / 1000)}s 前)`);
      return true;
    };

    /** 判定并注入一个已物化的会话；返回 true 表示已注入。 */
    const considerLive = (agent) => {
      const cfg = getConfig();
      const session = agent.session;
      if (!session || seen.has(session)) return false;
      seen.add(session);
      const sessionId = session.id;
      if (typeof sessionId !== "string" || sessionId === "" || resumed.has(sessionId)) return false;
      if (!cfg.includeSubagents && session.header?.origin === "subagent") return false;
      let events;
      try {
        events = snapshotSessionEvents(session);
      } catch (error) {
        log(cfg, `跳过 ${sessionId}: 会话历史不可读 (${error instanceof Error ? error.message : String(error)})`);
        return false;
      }
      if (events.length === 0) return false;
      const info = interruptedTurn(events, cfg);
      if (info === void 0) return false;
      if (sent >= cfg.maxPerBoot) {
        log(cfg, `跳过 ${sessionId}: 本次启动已续跑 ${sent} 个，达到上限`);
        return false;
      }
      return deliver(cfg, sessionId, info);
    };

    /**
     * 存储扫描：枚举全部持久化会话，命中的先物化再注入。
     * 持久化会话不会在启动时自动进注册表——没有这条路径，
     * 没被打开过的会话永远轮不到（实测会话被点开才被扫描到）。
     */
    const sweepStored = async (deadline) => {
      const cfg = getConfig();
      const query = ctx.get("sessionQuery");
      if (query === void 0) {
        if (!sweepAnnounced) {
          sweepAnnounced = true;
          log(cfg, "存储扫描不可用: 本宿主没有 sessionQuery 服务，只扫描已物化的会话");
        }
        return;
      }
      let records;
      try {
        records = await readStored(ctx, (signal) => query.listSessions(signal), deadline);
      } catch (error) {
        console.error(`[restart-resume] 存储扫描失败: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!Array.isArray(records)) return;
      if (!sweepAnnounced) {
        sweepAnnounced = true;
        log(cfg, `存储扫描就绪: ${records.length} 个会话记录`);
      }
      for (const record of records) {
        if (stopped || Date.now() >= deadline) return;
        const c = getConfig();
        if (!c.enabled) return;
        const sessionId = record?.header?.id;
        if (typeof sessionId !== "string" || sessionId === "") continue;
        if (sweptIds.has(sessionId) || resumed.has(sessionId)) continue;
        if (record.live || agents.get(sessionId) !== void 0) continue; // 存活路径已覆盖
        if (!c.includeSubagents && record.header.origin === "subagent") continue;
        sweptIds.add(sessionId);
        let observation;
        try {
          observation = await readStored(ctx, (signal) => query.observeSession(sessionId, { projectionMode: "all", signal }), deadline);
        } catch (error) {
          const n = (sweepFailures.get(sessionId) ?? 0) + 1;
          sweepFailures.set(sessionId, n);
          sweptIds.delete(sessionId); // 允许下一轮重试（最多 3 次）
          if (n >= 3) sweptIds.add(sessionId);
          continue;
        }
        const events = observation?.events;
        if (!Array.isArray(events) || events.length === 0) continue;
        const info = interruptedTurn(events, c);
        if (info === void 0) continue;
        if (sent >= c.maxPerBoot) {
          log(c, `跳过 ${sessionId}: 本次启动已续跑 ${sent} 个，达到上限`);
          continue;
        }
        if (c.dryRun) {
          log(c, `dry-run: 命中 ${sessionId}(turn ${info.turn}, ${info.cause}, ${Math.round((Date.now() - info.at) / 1000)}s 前)`);
          continue;
        }
        // 物化：优先走官方 sessionController（恢复会话自己的预设与模型选择）。
        const controller = ctx.get("sessionController");
        let materialized = false;
        if (controller?.resolveAgent !== void 0) {
          try {
            const result = await controller.resolveAgent(sessionId);
            materialized = result !== void 0 && result !== null && !result.error;
            if (!materialized && result?.error !== void 0) {
              log(c, `跳过 ${sessionId}: 官方恢复路径拒绝 (${JSON.stringify(result.error?.message ?? result.error).slice(0, 120)})`);
              continue;
            }
          } catch (error) {
            log(c, `官方恢复路径异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
        }
        if (!materialized) {
          try {
            await agents.resume({ resumeSessionId: sessionId });
          } catch (error) {
            log(c, `跳过 ${sessionId}: resume 失败 (${error instanceof Error ? error.message : String(error)})`);
            continue;
          }
        }
        deliver(c, sessionId, info);
      }
    };

    const boot = () => {
      const cfg = getConfig();
      if (!cfg.enabled) return;
      const startedAt = Date.now();
      const deadline = startedAt + cfg.freshMs;
      log(cfg, `启动扫描已排程(delay ${cfg.delayMs}ms, 窗口 ${Math.round(cfg.freshMs / 1000)}s, 上限 ${cfg.maxPerBoot}${cfg.dryRun ? ", dry-run" : ""})`);

      const tick = () => {
        if (stopped) return;
        const c = getConfig();
        if (!c.enabled) { stop(); return; }
        try {
          for (const agent of agents.list()) {
            if (stopped) break;
            considerLive(agent);
          }
        } catch (error) {
          console.error(`[restart-resume] 存活扫描异常: ${error instanceof Error ? error.message : String(error)}`);
        }
        void sweepStored(deadline).catch((error) => {
          console.error(`[restart-resume] 存储扫描异常: ${error instanceof Error ? error.message : String(error)}`);
        });
        const now = Date.now();
        // 一直轮询到窗口结束：持久化会话是懒物化的，早退会漏掉迟到的会话。
        if (now >= deadline) {
          log(c, `扫描窗口到期: 本次启动共续跑 ${sent} 个会话`);
          stop();
          return;
        }
        timer = setTimeout(tick, Math.max(1000, c.pollMs));
      };
      timer = setTimeout(tick, Math.max(0, cfg.delayMs));
    };

    boot();
  });
}
