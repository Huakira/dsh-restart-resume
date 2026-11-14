# dsh-restart-resume

> 个人自用，AI 辅助编写；装前请先备份会话数据。

给 DeepSeek Harness（DSH）补上「**干净重启后自动续跑被打断的会话**」。

## 它解决什么

用 supervisor / systemd 等进程管理器重启 dsh（发 TERM、进程正常退出）时，正在跑的回合会被 DSH 收尾成：

```
turn/end { "kind": "aborted", "reason": { "kind": "disposed" } }
```

重启后这些会话停在半路，要等你手动打开会话发一句「继续」才会动。

现有的续跑插件（dsh-client-auto-continue、dsh-interrupted-resume、dsh-recovery-resume 等）的主会话扫描都只认 `error` / `interrupted` / `max-tokens`——`interrupted` 只有在进程崩溃（来不及收尾）时才会出现，`aborted` 一律跳过（防用户手动停止被误续）。**干净重启的 `aborted/disposed` 信号落在整个生态的盲区里**，本插件只补这一块。

## 行为

- 每次启动后轮询 agent 注册表（会话是懒物化的），找「最后一个回合以 `aborted` + 子原因 `disposed`（宿主销毁）或 `legacy` 收尾、且之后没有新回合或用户消息」的会话，注入一条续跑消息。
- 人为取消（`user` / `parent` / `hook` 子原因）**绝不续**；正常结束、报错、截断也**不碰**（那些归 dsh-client-auto-continue 管，两者无重叠、不会双发）。
- 子代理会话默认跳过（由父会话管理）。
- 防护：每个会话每次启动最多续 1 次；每次启动总量上限 `maxPerBoot`；中断超过 `freshMs` 窗口不翻旧账。
- 纯宿主半边，无浏览器端代码，装完重启 dsh 即生效。

## 安装

```sh
dsh plugin --profile web add @huakirax/dsh-restart-resume
```

装完重启 dsh。

## 配置

默认值在代码里，零配置即可工作。要调参，在 profile 的 `cordis.patch.yml` 里加一行（补丁替换整份 config，代码侧会把缺失的键回落到默认值）：

```yaml
- id: restart-resume
  config:
    enabled: true        # 总开关
    delayMs: 8000        # 启动后等多久开始首轮扫描
    freshMs: 900000      # 中断新鲜度窗口（15 分钟），也是轮询总时长上限
    pollMs: 3000         # 轮询间隔
    maxPerBoot: 8        # 每次启动最多续跑几个会话
    dryRun: false        # true = 只打日志不注入，用于验收
    verbose: true        # 详细日志（stdout）
    includeSubagents: false
    prompt: |            # 续跑消息正文，支持 {turn} 占位符
      [自动续跑 · 由 dsh 重启触发]
      ...
```

## 验收

```sh
dsh --profile web --dump-config | grep -A2 restart-resume   # 确认插件行在位
# 日志（stdout）里应出现：
# [restart-resume] 启动扫描已排程(...)
# [restart-resume] 扫描完成: 本次启动共续跑 N 个会话
# 命中时：[restart-resume] 已注入续跑消息 -> <sessionId>(turn N, disposed, ...)
```

实测方法：让一个会话正在跑活时重启 dsh，重启后不手动发消息，该会话应在十几秒内自己接上。

## 限制

- 依赖内部约定：`turn/end` 的 `aborted` 子原因枚举、`ctx.agents.list()`、`agent.followup()`、`session.header.origin`。DSH 升级后若失效，优先核对这些接口。
- 与 dsh-client-auto-continue 同时安装是安全的：它永不触碰 `aborted`，本插件只碰 `aborted` 的宿主销毁子类。

## 许可

MIT
