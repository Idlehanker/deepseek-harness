# Agent Note: 交互式终端（tui）profile

Status: implemented

[English](2026-08-16-tui-profile.md)

## 问题

启动器帮助中宣传了 `dsh --profile tui`，但没有随发行版交付的模板支撑这个名字：`loadProfile` 对它明确报错，而唯一不带服务器的界面是一次性的 `headless` 运行器。交互式终端对话——即 Claude Code CLI 的形态——需要一个能在 readline 循环中驱动单个 Agent 的组合包，且不引入 Host、HTTP 或浏览器层。

## 决策

**新增 `tui` 组合包 `@deepseek-ai/dsh-tui`（`packages/bundle/tui`），沿用 headless 模板。** 它的 `cordis.patch.yml` 叠加在 `dsh-base` 之上：编码 persona、关闭 HMR、Code Mode worker，以及一个插入的 `tui-runner` 行。`PROFILE_TEMPLATES` 增加 `tui: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui']`，使 `dsh --profile tui` 像 `web` 和 `headless` 一样首次使用自动初始化；`apps/cli` 依赖该组合包，使安装回退目录可以解析它。

**runner 在一个窄的 `TuiIo` 接口上驱动 REPL。** Loader 就绪后创建一个持久化 Agent（与 headless 相同的 `installModelSelection` 设置），然后循环：每行输入成为一个普通的 `followup` 回合，并通过 `whenIdle()` 等待。`TuiIo`（`write`/`error`/`prompt`/`close`）有一个 stdio 上的 readline 默认实现；`internals.createIo` 让测试替换为脚本化控制台，真实 readline 封装通过 `PassThrough` 模拟 stdio 覆盖。

**渲染是纯折叠。** `TranscriptRenderer`（`src/render.ts`）把实时 `session/event` 记录折叠为可打印文本：`assistant/chunk` 文本增量原样流式打印，`tool/call` 打印单行 `● name(args-preview)` 指示，失败的 `tool/result` 打印 `✗` 行，流的开闭状态负责它们之间的换行。终止性 `turn/end` 错误原因写入 stderr。

**审批提问内联回答且失败关闭。** 一个根级 `approval/request` waterfall 监听器只认领 runner 自己的 Agent（其他 Agent 经 `next()` 委派），并把输入映射到结果词表：明确的 `y`/`yes` 授予 `allowed-once`；其余一切——包括 EOF——拒绝。

**退出由启动器持有。** `/exit`、`/quit`、EOF 或 Ctrl+C 结束循环、冲刷会话并请求 `ctx.appExit(0)`；缺少 `appExit` 在激活时抛错，与 headless 一致。

## 曾考虑的替代方案

**复用 headless runner 并加循环开关。** 不采用：一次性聚合（静默后折叠、把回合结束原因映射为进程退出码）与实时输出是不同的契约，共享驱动会让两者纠缠。

**经 SDK JSON-RPC 服务器驱动对话。** 不采用：TUI 是同进程的；有线协议只会为一个并不需要的解耦增加一层传输和第二个运行时。ACP/JSON-RPC 演示仍是远程界面。

**全屏终端 UI 库（ink、blessed）。** v1 不采用：面向行的 readline 循环以零新增依赖覆盖核心循环；富渲染（markdown、diff、加载动画）之后可以叠加在同一个 `TuiIo` 接口上。

**把用户输入的斜杠命令分发给 base 的 `commands` 能力。** 暂缓：该界面目前面向模型；把 REPL 命令接入它是另一个独立决策。

## 后果

`dsh --profile tui` 可在任意终端启动具备完整 base 工具栈、流式回复与内联审批的交互式编码 agent。已知缺口记录在包 README 中：无回合中转向或中断、无 `--resume`、除 `/help` 与 `/exit` 外无用户斜杠命令、文本原样输出（无渲染）。三个源文件单元覆盖率为 100%；尚无免密钥快照，因为快照框架驱动的是组装后的应用输出，而交互式 stdin 回放通道是当前夹具所不具备的。
