# focus-todo（专注待办）

[English](README.md) | [中文](README.zh-CN.md)

一个极简的 OpenCode v2 插件，为每个会话维护一份小小的专注清单（focus checklist），
让智能体在长任务、上下文压缩或重启之后能够恢复工作状态。设计为**全局安装一次**，
之后每个项目的每个会话都自动拥有它。

一个工具。一份状态。零依赖。一条不破坏缓存前缀的提醒。

```
focus_todo(action="replace", items=[{text:"wire up storage", status:"in_progress"}, {text:"write tests"}])

2 active, done=0
t1:> wire up storage
t2:- write tests
```

在存在开放项时，模型会在每个用户轮开始看到一行开放清单提醒：

```
[focus_todo] 2 open: t1> wire up storage | t2- write tests
```

而人类在智能体工作时会看到侧边栏里的同一份清单——已完成的行保留并打上标记：

```
▼ Focus 2 active, done 1
▶ t1 wire up storage
○ t2 write tests
✓ t3 read the spec
```

面板是侧边栏的常驻部件：在第一次调用 `focus_todo` 之前显示 `▼ 暂无待办`，而不是消失。
点击表头（`▼`/`▶` 箭头所在行）可以把面板折叠成只剩表头——表头保留了计数，
所以折叠后依然能看出"这个计划进行到哪了"。折叠状态通过宿主自身的 UI 偏好存储
跨重启保留；宿主若不提供该能力，折叠照常工作，只是重启后重置。

## 安装（全局，推荐）

把插件目录复制到 OpenCode 的配置目录：

```bash
# Windows (Git Bash / PowerShell)                  # Linux / macOS
mkdir -p ~/.config/opencode/plugin                mkdir -p ~/.config/opencode/plugin
cp -R src/focus-todo ~/.config/opencode/plugin/focus-todo
```

Windows 下完整路径是 `C:\Users\<你>\.config\opencode\plugin\focus-todo\`。
不需要在 `opencode.json` 里注册、不需要 `npm install`、不需要构建：OpenCode 启动时
扫描该目录下的 `plugin/` **和** `plugins/`，把每个条目当作一个插件，并从中解析
`server.ts`。

**只装一份。** 加载器不会按插件 id 去重：项目副本 + 全局副本会在该项目里加载两次，
意味着注册两个 `focus_todo`、渲染两个侧边栏面板。这是实测结论，不是推测。

重启 OpenCode（或开新会话）后，所有项目都有这个工具。在任意项目里验证：

```
opencode run --model <provider/model> "Call focus_todo with action=list and show the raw output."
```

### 项目级安装

只想在某个项目使用的话，把同一个目录复制到 `<project>/.opencode/plugin/` 即可——
并且不要再装全局副本（原因如上）。

## 卸载

删除目录并重启 OpenCode，没有其他东西引用它：

```bash
rm -r ~/.config/opencode/plugin/focus-todo
```

每个会话的状态以 `focus-todo/session/<sessionID>` 为键留在 OpenCode 自己的存储里。
插件删除后它只是惰性数据，可以留着，也可以随会话一起自然过期。

## 使用

一个工具，三个**公开** action：

| action | 必填字段 | 效果 |
| --- | --- | --- |
| `list` | — | 读取当前状态，只读。 |
| `replace` | `items[]` | 整体替换计划；`[]` 清空行并重置 `done`。 |
| `mutate` | `ops[]` | 按序执行 1–24 个 `add`/`update`/`remove` 操作，全有或全无。 |

用 `update` 的 `done: true` 完成一项：该行保留为 `x`，并增加 `done` 计数。`remove`
只移除行，不改变计数。旧的 `add`、`update`、`remove`、`batch`、`complete`、`clear`
输入仍在运行时兼容，但不会出现在公开 schema 中。

工具强制执行：最多 16 条开放项、最多保留 16 条完成行、每项最多 150 字符、最多一条
开放项为 `in_progress`；空文本、非法状态、重复 id、未知 id 会明确报错；`mutate` 任一
操作失败时整批不写入。

状态标记为 `pending`（`-`）、`in_progress`（`>`）、`blocked`（`!`）和完成行 `x`。
完成行在工具结果和侧边栏中保留，但不会进入请求尾提醒。

典型流程：

```
1. focus_todo { action: "replace", items: [{text:"读规格"}, {text:"实现存储", status:"in_progress"}] }
2. ……工作……
3. focus_todo { action: "mutate", ops: [{action:"update", id:"t2", done:true}] }
4. focus_todo { action: "mutate", ops: [{action:"add", text:"处理损坏状态", status:"in_progress"}] }
5. 下一份计划 → focus_todo { action: "replace", items: [...] }
```

重启或压缩后调用 `focus_todo(action="list")` 即可恢复持久化状态。

## 一个请求的完整链路

```
OpenCode 启动
  └─ server.ts → 一个 focus_todo 工具 + 一个 context hook
     tui.tsx   → 一个只读侧边栏面板

模型调用 focus_todo
  └─ 校验 → 读 storage → 纯状态转换 → 按会话串行写入 → 返回完整紧凑状态

请求进入 context hook
  ├─ 工具链/非用户尾部：立即返回（默认路径不读 storage）
  ├─ 用户轮尾部：只读一次状态
  ├─ 空状态或没有开放项：不追加
  ├─ 同一用户消息已处理：不重复追加
  └─ 否则在请求最后追加一行仅含开放项的提醒

TUI
  └─ 解析最新 focus_todo 结果，只渲染事实，不写状态
```

提醒不持久化，也不修改 system prompt、工具定义或历史消息。storage、hook 或插件初始化
失败时只损失对应功能，不会破坏当前请求。

## 模型是怎么一直知道的

三个通道共同增强注意力；当会话存在开放项时，请求尾提醒默认开启：

1. **工具描述**：告诉模型何时读取或记录计划，且属于可缓存的工具定义。
2. **工具结果**：每次真实调用都返回完整紧凑状态。
3. **请求尾提醒**：有开放项时，在用户轮开始追加一行：

```
[focus_todo] 2 open: t1> implement storage | t2- write tests
```

提醒只包含开放项，按注意力排序，并受 `reminderBudget` 限制；工具链中不追加，也不持久化。
普通用户文本即使包含 `[focus_todo]` 也不会误触去重，去重依据是插件尾部 id 和用户消息 id。

发布默认 `staleAfter: 0`：空会话不邀请建立清单，也不发送维护催更。只有显式开启后，才会在
用户轮开始按节奏发送可选 nudge；被识别为 subagent 的会话仍会静默。

### 配置

可选配置文件：`~/.config/opencode/focus-todo.json`（或 `server.ts` 同目录）。默认值：

```json
{
  "reminder": true,
  "reminderBudget": 360,
  "staleAfter": 0,
  "itemChars": 48,
  "maintenanceNudge": " — update if changed",
  "creationNudge": "[focus_todo] no list yet"
}
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `reminder` | `true` | 开启请求尾提醒；`false` 时连 session hook 都不访问。 |
| `reminderBudget` | `360` | 生成提醒的最大字符数。 |
| `staleAfter` | `0` | 安静 hook 调用数达到该值后才允许 nudge；`0` 关闭两种 nudge。 |
| `itemChars` | `48` | 提醒中每项的截断长度。 |
| `maintenanceNudge` | ` — update if changed` | 开启维护 nudge 时附加的短句。 |
| `creationNudge` | `[focus_todo] no list yet` | 开启空会话 nudge 时使用的短句。 |

`FOCUS_TODO_REMINDER`、`FOCUS_TODO_REMINDER_BUDGET`、`FOCUS_TODO_STALE_AFTER` 和
`FOCUS_TODO_ITEM_CHARS` 可用环境变量覆盖文件配置。

### 为什么提醒不破坏缓存

* 它追加在**一切之后**。请求里没有任何东西被重排、重写或挪位，可复用前缀——系统提示、
  工具定义、以及此前每一条消息——逐字节保持不变。在录得的出站请求上实测：工具定义
  逐字节相同、系统提示逐字节相同（18 151 字节）、每个请求与上一个的共享前缀是
  *除上一条提醒之外的全部*。
* 它从不落盘：没有任何合成消息写入会话，会话记录保持 append-only，什么都不累积。
  会话存储里实测：16 条持久化消息，含提醒文本的 **0** 条。
* 它每个请求都从 storage 重建——这正是压缩无法钝化它的原因：提醒不属于可被压缩的
  对话，无论历史发生了什么，模型在下一个请求里都会再次被提醒。
* 无话可说时零开销：没有开放项的会话**不会**得到状态行；该行有界（每条 `itemChars`、
  总计 `reminderBudget`）。空会话唯一可能画出的只有邀请，而且只在 `staleAfter` 节奏上。

### 开销实测

固定工具定义位于可缓存前缀；插件新增的 per-request 文本只有提醒，并受 `reminderBudget` 限制。
默认 `staleAfter: 0` 时，空会话不增加提醒 token；有计划时每个用户轮开始最多增加一行。
工具结果只在模型主动调用工具时产生开销，侧边栏是本地 UI，不进入模型上下文。

需要精确 provider/token 数字时，请用 `verify/cost-report.mjs` 对真实捕获计算；不要把旧捕获中的
字节数当成产品常量。

## 侧边栏面板

TUI 注册一个只读面板：

| 会话状态 | 面板 |
| --- | --- |
| 有开放项 | `Focus N active[, done M]`，然后开放行与保留的完成行 |
| 无开放项但有完成行 | `Focus: all done`，然后完成行 |
| 无开放项且完成行也移除 | `Focus 0 active, done N` |
| 尚未建清单或 `replace(items: [])` 后 | `暂无待办` |

面板刻意没有“已提醒/未提醒”状态行。提醒属于请求 hook，TUI 进程无法可靠重建它；面板只读取
最新可解析的 `focus_todo` 工具结果，不写状态、不轮询，也不建立第二份待办存储。

## 它如何不打扰别人

* **存储就是 OpenCode 自己的。** 状态走官方 `context.storage` 键值域，每会话一键。
  没有插件 JSON 文件、没有数据库、没有迁移。
* **失败从不阻塞启动。** setup 按特性逐一守卫：工具注册失败，提醒和面板完好；钩子
  失败只损失提醒；状态读不动则带警告重置；同一会话的写操作串行化，不丢数据。
* **与 billion-context 共存。** 它只注册一个工具（`focus_todo`），从不触碰
  billion-context 的工具、头、提示或状态，移除 billion-context 后照常工作。共存是实测
  的，不是假设的：在录得的捕获上 **16/16** 请求携带 billion-context 的
  `<acp tokens="…">` 标记、十二项缓存前缀检查全过，提醒依然落在 billion-context
  `<acp>` 包裹内的最后。billion-context 侧还有一个设置能让*清单本身*在提醒之外也免于
  压缩——在其配置里加 `compress.protectedLatestTools: ["focus_todo"]` 保护最新快照。
  没有它插件行为完全一致（提醒在符合条件的用户轮从 storage 重建）；若你开启了 billion-context 的
  压缩，建议加上。
* **轻。** 三个文件，除宿主自身的虚拟模块外零 import，零 npm 依赖，会话不用工具时
  无任何后台工作。

## 开发

仓库的 `src/focus-todo/` 是**源码**；OpenCode 实际加载的是
`~/.config/opencode/plugin/focus-todo/` 下的安装副本。改完源码后重新复制过去：

```bash
cp -R src/focus-todo/. ~/.config/opencode/plugin/focus-todo/
```

```bash
bun test                       # 单元测试，含一个带种子的不变量扫描
bunx --bun tsc --noEmit        # 严格类型检查，不需要 node_modules
```

### 线缆验证

`verify/` 附带一套小工具，用一个**假的、脚本化的 OpenAI 兼容 provider** 在线缆层验证
插件——零模型开销，完全确定性：

```bash
# 终端 1 —— 本地记录器/provider，监听 :45999，记录每个出站请求体
node verify/fake-provider.mjs          # WIRE_LOG=<文件> 指定捕获文件

# 然后把测试项目的 opencode.json 指向 http://127.0.0.1:45999/v1
# 驱动一个会话，之后：

node verify/analyze.mjs                # 12 项缓存前缀 + 提醒位置检查
WIRE_LOG=<捕获> node verify/cost-report.mjs   # 重印上面的开销表
```

捕获文件（`WIRE_LOG` 产物）是机器本地的，已被 git 忽略；请自行重新生成。

### 无头 TUI 捕获

在真实、无头的 TUI 里复检侧边栏。`OPENCODE_DRIVE=1` 让 OpenCode 无终端渲染并监听
`ws://127.0.0.1:40900`，`verify/drive-capture.mjs` 断言屏幕上的内容：

```bash
# 终端 1 —— 无头启动 TUI（替换 opencode 路径 / 项目目录）
OPENCODE_DRIVE=1 <opencode路径> --session <sessionID>

# 终端 2 —— 断言渲染帧
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus 2 active" "t1 wire up storage"
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus: all done"
node verify/drive-capture.mjs <clear后的sessionID> --min-col=150 "暂无待办" "!Focus"
```

`--min-col` 证明文本位于右侧边栏区域而非会话记录区，`!text` 断言不存在（空态用例），
脚本会打印它找到的一切的行/列位置。

`opencode run` 每次调用都起新进程，内存里的东西会看不见。`verify/drive-chat.mjs` 改为
向同一个无头 TUI 里打字，连续的用户轮落在同一进程里——催更节奏就是这样量出来的：

```bash
node verify/drive-chat.mjs --wire my-capture.jsonl --messages "one|two|three|four"
```

复现时有两点值得知道：裸的 `opencode` 命令没有 `--model` 参数，TUI 的模型来自项目的
`opencode.json`（在里面钉一个假模型，确保够不到真实 provider）；插件的**服务半区跑在
后台 service 里**，不在 TUI 进程里——它的环境变量来自 service 的启动处，不是启动器。

## 目录结构

```
src/focus-todo/server.ts        插件本体：工具、存储绑定、请求尾提醒、v2 入口
src/focus-todo/tui.tsx          只读侧边栏面板
src/focus-todo/view.ts          面板与测试共享的纯视图逻辑
tests/focus-todo.test.ts        工具、存储、提醒与入口测试
tests/focus-todo-view.test.ts   视图逻辑测试（解析、裁剪、面板分支）
tests/tui-panel.test.ts         面板注册、清理与渲染测试
tests/focus-todo-invariants.test.ts  对状态不变量的种子化随机负载测试
types/                          测试运行器、solid 与 JSX 的环境类型，tsc 无需 node_modules
tsconfig.json                   严格配置
verify/                         线缆验证工具（假 provider、分析器、无头 TUI 驱动）
```

`src/focus-todo/` 是自包含的：复制这一个目录，安装即完整。

## 许可

MIT。本插件未复制任何第三方代码；其他 OpenCode 插件仅在命名约定等设计层面被参考。
`verify/` 是开发脚手架，不属于安装的插件。
