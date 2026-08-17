# `@deepseek-ai/dsh-tui`

[English](README.md) | 中文

dsh 交互式终端组合包。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.md) 之上：提供编码 persona 与工具模式、关闭 HMR、把 Code Mode 的 worker 作为核心执行能力挂载，并插入本包的 `tui-runner` 插件。它不挂载 Host、HTTP 服务器、Web 运行时或浏览器插件。

通过 `dsh --profile tui` 启动。Loader 就绪后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md)，通过 `ctx.agents` 创建一个全新的持久化 Agent，打印横幅（模型路由与工作目录），然后进入 readline 提示符循环。每输入一行就成为一个普通的跟进回合；回合运行期间，runner 把实时的 `session/event` 记录折叠成终端输出——`assistant/chunk` 文本增量原样流式打印，`tool/call` 渲染为单行 `● name(args-preview)` 指示，失败的 `tool/result` 打印 `✗` 行。纯折叠逻辑在 [`src/render.ts`](src/render.ts)（`TranscriptRenderer`），不依赖 io。`approval/request` 提问在终端内联回答（`[y/N]`，除明确肯定外一律拒绝，因此该回答器是失败关闭的），且只认领 runner 自己创建的 Agent 的提问；其他 Agent 的提问沿回答链继续委派。终止性的 `turn/end` 错误原因会把错误码与消息写入 stderr。

`/help` 打印命令列表；`/exit`、`/quit`、Ctrl+D（EOF）或 Ctrl+C 结束循环，冲刷 Session，并通过启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.md)）以 0 退出。进程不打开任何监听端口。控制台是一个窄的 `TuiIo` 接口（`write`/`error`/`prompt`/`close`），默认实现是 stdio 上的 readline；测试通过 `internals.createIo` 替换为脚本化控制台。

## 模型体验

无，因为 runner 把每行输入作为普通用户消息提交；提示词与工具属于组合后的 base 与 tui 组合包。

#### KV Cache 影响

无；runner 不向请求前缀添加任何内容。

## 已知限制与暂缓事项

- **回合中无法输入** —— 回合运行期间提示符不活跃；转向输入、中断（取消当前回合）与排队输入暂缓。Ctrl+C 走启动器的关闭路径，而非回合取消。
- **不支持 `--resume`** —— 每次启动都创建新会话；恢复持久化会话暂缓。
- **除 `/help` 与 `/exit` 外没有斜杠命令界面** —— base 的 `commands` 能力面向模型；REPL 尚未把用户输入的斜杠命令分发给它。
- **无标记渲染** —— 助手文本原样流式输出；markdown 渲染、语法高亮与 diff 卡片暂缓。
- **`ctx.appExit` 由启动器持有** —— 在 `dsh` 启动器之外启动 tui profile 会在激活时明确报错，直到宿主提供退出请求。
