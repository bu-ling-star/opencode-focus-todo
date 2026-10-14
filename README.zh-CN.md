# focus-todo（专注待办）

[English](README.md) | [中文](README.zh-CN.md)

一个极简的 OpenCode v2 插件，为每个会话维护一份小小的专注清单（focus checklist），
让智能体在长任务、上下文压缩或重启之后能够恢复工作状态。设计为**全局安装一次**，
之后每个项目的每个会话都自动拥有它。

一个工具。一份状态。零依赖。一条不破坏缓存前缀的提醒。

```
focus_todo(action="replace", items=[{text:"wire up storage", status:"in_progress"}, {text:"write tests"}])

3 active, done=0
t1:> wire up storage
t2:- write tests
```

模型在每次请求的末尾还能看到一行开放清单的提醒：

```
[focus_todo] 2 open: t1> wire up storage | t2- write tests
```

而人类在智能体工作时会看到侧边栏里的同一份清单——已完成的行保留并打上标记，
还有一行说明模型最近一次被告知的状态：

```
▼ Focus 2 active, done 1
已提醒待办
t1:> wire up storage
t2:- write tests
t3:x read the spec
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

一个工具，一个 `action` 联合类型：

| action | 必填字段 | 效果 |
| --- | --- | --- |
| `list` | — | 返回开放项与完成计数。只读。 |
| `replace` | `items[]` | 用这批条目整体覆盖清单——新计划从零开始，旧计划的标记行**和** `done` 计数一并清掉。每项：`{id?, text, status?}`。 |
| `add` | `text` | 追加一项（`status` 默认 `pending`）。 |
| `update` | `id` | 修改某一项的 `text` 和/或 `status`。 |
| `complete` | `id` | 标记完成：该行保留为 `x`，`done` 加一。 |
| `remove` | `id` | 直接移除该项，不计入完成（若已标记也不回退计数）。 |
| `clear` | — | 清空所有开放项、标记行**和** `done` 计数：会话回到从未用过这个工具的状态。 |

工具强制执行的规则，违反时返回一行简短的 `error=…`：

* 开放项最多 16 条；
* 每条最多 150 字符；
* 每会话最多保留 16 条标记行——超出时先丢最旧的标记，`done` 计数不受影响继续累加；
* 同时只能有一项 `in_progress`（标记行不占用该名额）;
* id 按会话内短小、稳定、可预测地分配（`t1`、`t2`、……），永不复用，新计划也不复用；
* 空文本、未知状态、重复 id、未知 id 都被显式拒绝。

错误信息按"能自愈"而非"只能终止"来写：未知 id 会列出实际存在的 id
（`error=unknown id t7; open ids: t1 t2 t3`），第二个 `in_progress` 会指名已在运行的条目
（`error=only one in_progress allowed (t1 is in_progress)`），模型可以在同一轮内自行纠正，
不必为 `list` 多花一个来回。

状态：`pending`（`-`）、`in_progress`（`>`）、`blocked`（`!`），以及工具结果和面板里
标记行的 `x`。标记行是"已完成"，不是"消失了"：模型在每次工具结果里都还能看到它，
它不再计入开放数，也不再出现在提醒里。

**一份计划拥有自己的标记和计数。** `complete` 打标记并让 `done` 加一；两者在该计划的
生命周期内始终可见，包括最后一项完成之后，侧边栏因此能展示刚完成的工作。开新计划
（`replace`）或清场（`clear`）会连同标记行**和** `done` 计数一起清掉——`done` 回答的是
"这份计划进行到哪了"，而不是"我总共做了多少"，所以它不会跨不相关的工作累积。
`remove <id>` 是唯一两者都不动的操作：移除一行不等于取消完成，计数保持在原值。

典型的智能体流程：

```
1. focus_todo { action: "replace", items: [{text:"read the spec"}, {text:"implement storage", status:"in_progress"}] }
2. ……干活……
3. focus_todo { action: "complete", id: "t2" }   → 1 active, done=1
4. focus_todo { action: "add", text: "handle corrupt state", status: "in_progress" }
5. ……这份计划做完了，下一份开始……               → focus_todo { action: "replace", items: [...] }  → done=0
```

重启或压缩之后，智能体调用 `focus_todo { action: "list" }` 就能拿回开放项、标记行和
`done=N`。

## 一个请求的完整链路

```
OpenCode 启动
  └─ 扫描 plugin/ ，加载一个目录 → 两个入口
       server.ts : 注册 focus_todo 工具 + 一个 "context" 钩子
       tui.tsx   : 认领侧边栏槽位（只读），别无其他

模型决定记录或读取计划
  └─ focus_todo { action, … }
       ├─ 校验输入                    → 错误时返回一行简短 `error=…`
       ├─ 从 context.storage 读取 focus-todo/session/<sessionID>
       ├─ 对状态应用操作（纯函数，无 I/O）
       ├─ 写回，revision + 1            （按会话串行化：不会交错）
       └─ 返回一段紧凑的文本结果：表头 + 开放行 + 标记行

每个出站请求，在宿主组装完成后
  └─ 同一个 "context" 钩子运行一次
       ├─ 读取状态（一次 storage 读）
       ├─ 若没有开放项，或最新消息已经是该工具结果 → 什么都不追加
       ├─ 否则以最后一条消息的身份追加一行，绝不写回会话
       └─ 用户轮开始且已连续 `staleAfter` 个请求无清单活动时，附加催更

侧边栏（TUI 进程，与模型路径分离）
  └─ 重渲染时读取会话消息窗口里最新的 focus_todo 结果
       ├─ 不写、不轮询、零 token
       └─ 表头 + 已提醒待办 / 未提醒 + 行，或 暂无待办

压缩或重启
  └─ 什么都不变：状态在 storage 里，工具描述在冻结前缀里，
     提醒在下一个请求里从 storage 重建
```

失败行为各一句话：storage 读失败 → 附带 `warn=state store unavailable` 通知并以内存清单
继续服务；写失败 → 报告 `error=state store write failed`；钩子失败或插件加载失败 → 记日志
且不碰请求——这个插件永远搞不砸一轮对话，最多搞砸它自己的提醒。

## 模型是怎么一直知道的

三条通道，按侵入性递增——第三条有一个更响的变体。只有第三条会碰请求，且只碰末尾。

1. **工具描述** —— 冻结文本，告诉模型在开始或恢复工作、经历压缩、重启之后调用
   `focus_todo(action="list")`，用 `replace` 记录多步计划，单个琐碎步骤不要建清单，
   每条只写几个词。它是工具定义的一部分，每个请求逐字节相同，而且不是对话内容，
   压缩拿不掉它。
2. **每次工具结果** —— 任何 `focus_todo` 调用都返回整份清单，状态在每次更新后
   立刻进入会话记录。
3. **请求尾提醒** —— 一行，作为出站请求的*最后一条*消息追加，每次从 storage 重建：

   ```
   [focus_todo] 2 open, 1 done: t1> implement storage | t2- add tests
   ```

   这一行按注意力排序：运行中的条目最先，然后是 `blocked`，其余按清单顺序；预算装不下
   时以 `+k more` 结尾，而不是悄悄丢条目：

   ```
   [focus_todo] 16 open: t1> implement storage | t2! waiting on review | t3- add tests | … | +8 more
   ```

   两道守卫让它永远不会变成噪音。最新消息已经显示同一状态时不追加——也就是刚调用过
   `focus_todo` 工具之后，模型刚刚读过清单——插件被加载两次时也不会追加两次。
   线缆实测：16 项清单下，8 个请求里只有 3 个携带它，不携带的恰好是尾部已经是
   待办结果的那些请求。

   这一行**只携带开放项**，表头注明已标记数（`2 open, 1 done: …`）。标记行本身刻意
   不重发：模型只需要知道还剩什么，而看侧边栏的人想看到已完成的部分。两者来自同一份
   状态，渲染成两种样子。

4. **催更（nudge）—— 同一行，偶尔提及工具。** 两种形态，都只出现在*用户轮开始*时
   （新指令被读取的时刻，也是唯一值得花 token 催的时刻），且只在清单已经闲置
   `staleAfter` 个请求时出现：

   * 状态行加一个条款——`… | t3- update docs — update it if it changed`；
   * 完全**没有清单**的会话收到的不是状态行，而是单独一行：
     `[focus_todo] no list yet — focus_todo is available if you want to record a plan`。

   两种形态在**子代理会话**里都静默：setup 时读一次宿主的 agent 注册表（`agent.list()`，
   `mode: "subagent"` 的条目——`explore`、`general` 以及任何自定义子代理），这些 id 永远
   听不到催更，因为子代理生命周期太短，邀请没有价值。信息性提醒不受影响，注册表读取
   失败则保持原行为，未知 agent 绝不猜测。

   两者都不限量。一直不用清单的会话每隔 `staleAfter` 个请求会再次听到工具的存在；
   有清单但被无视时条款同样按节奏回归——催更一旦发出就重置计数，所以相邻两轮不可能
   连发两条，但两者都没有终身上限。邀请的措辞是"可用性"而不是命令：它从不指挥模型
   调用任何东西，因为不想要清单的会话有权没有清单。

   诚实的边界：催更**不会**让 `qwen3.8-flash` 自发开始建清单——三次真实模型探针
   （其中一次邀请就在场）产生零次主动的 `focus_todo` 调用，而被要求时模型用得很顺。

### 配置

`~/.config/opencode/focus-todo.json`（或放在 `server.ts` 旁边）。插件所有可调整的行为
都在这里；文件里全部键都按默认值写出，自文档化：

```json
{
  "reminder": true,
  "reminderBudget": 360,
  "staleAfter": 6,
  "itemChars": 48,
  "maintenanceNudge": " — update it if it changed",
  "creationNudge": "[focus_todo] no list yet — focus_todo is available if you want to record a plan"
}
```

| 键 | 默认 | 含义 | 范围（越界自动钳制） |
| --- | --- | --- | --- |
| `reminder` | `true` | 是否追加请求尾提醒。`false` 时插件连 session 域都不打开。 | — |
| `reminderBudget` | `360` | 生成的状态行字符数上限。催更条款先从预算里扣除，装不下时状态行让位；自定义条款超过剩余空间时按原文使用（你的文本永不被截断）。 | 80…2000 |
| `staleAfter` | `6` | 连续多少个请求无清单活动后，用户轮开始时附加催更（上述两种形态）。这是插件唯一的节奏——两种形态都按它无限重复。`0` 关闭两者，保留信息性提醒。 | 0…200 |
| `itemChars` | `48` | 那一行里每条条目保留的字符数（截断前）。 | 16…200 |
| `maintenanceNudge` | `" — update it if it changed"` | 闲置轮开始时粘在状态行尾的条款。前导空格会被保留，间距由配置文件控制。 | ≤300 字符 |
| `creationNudge` | `no list yet …` 那行 | 无清单会话收到的整行。措辞是"可用性"，从不指挥模型调用任何东西。 | ≤300 字符 |

环境变量可为单次运行覆盖文件配置：`FOCUS_TODO_REMINDER`、`FOCUS_TODO_REMINDER_BUDGET`、
`FOCUS_TODO_STALE_AFTER`、`FOCUS_TODO_ITEM_CHARS`（两条文本只能配在文件里——它们是
散文不是开关）。

文件缺失、类型错误、取值非法、JSON 损坏，全部逐键回退默认值：手滑不可能把插件配置坏，
上述钳制范围也都在单元测试里复检。

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

| 部分 | 大小 | 何时支付 |
| --- | --- | --- |
| 工具块（`name` + 描述 + 输入 schema） | 1566 字符 ≈ 392 tokens | 每请求一次，位于缓存前缀内（缓存读，不是写） |
| —— 其中描述 | 418 字符 ≈ 105 tokens | " |
| —— 其中输入 schema | 1046 字符 ≈ 262 tokens | " |
| 请求尾提醒 | 16 请求捕获中实测最大 123 字符 ≈ 31 tokens；上限 `reminderBudget` 360 字符 ≈ 90 tokens | 每请求，且仅当有开放项且尾部尚未显示（16 请求中 7 个携带） |
| 催更条款（`— update it if it changed`） | +26 字符 ≈ 6 tokens（计入同一预算） | 仅闲置的用户轮开始时 |
| 邀请行（`no list yet …`） | 76 字符 ≈ 19 tokens | 按 `staleAfter` 节奏，不限量——空会话闲置时每 `staleAfter` 个请求一次 |
| 工具结果（模型读回的清单） | 实测 195 字符 ≈ 49 tokens；最坏 16 项 ≈ 2.7 KB ≈ 675 tokens | 仅模型自己调用时 |
| 结果里的标记行 | ≤ 16 × 32 字符 ≈ 128 字符 ≈ 32 tokens | " |
| storage 里的会话状态 | ≤ 16 开放 + 16 标记 ≈ 3 KB，每会话一键 | 零 token |
| 侧边栏面板 | 0 字节 | 永远不进模型 |

作为参照：宿主发送的 19 个工具合计 21 092 字符，本插件占**工具面的 7%**；系统提示
17 770 字符 / 18 151 字节，未触碰。两条单元测试守住预算：一条封顶描述与 schema，另一条
在描述被改写时若有八条行为规则中的任何一条丢失就会失败。`verify/cost-report.mjs` 可以
从任意捕获重印上表，让数字保持诚实（如何生成捕获见[开发](#开发)）。

## 侧边栏面板

`tui.tsx` 在侧边栏内容区注册一个只读面板：

| 会话状态 | 面板 |
| --- | --- |
| 有开放项 | `Focus N active[, done M]`、一行状态、然后所有行——开放项在前，标记行在后且最新完成在最前（`t3:x read the spec`） |
| 无开放项、标记行还在 | `Focus: all done`、一行状态、然后标记行 |
| 无开放项、标记行也都被 `remove` 了 | `Focus 0 active, done N` —— 计数才是真相，空身体上写 `all done` 像个 bug |
| 还没有清单，或 `clear` 之后 —— `0 active, done=0` | 单独一行 `暂无待办` —— 没有状态行，因为从未发送过任何东西 |

状态行是面板第二行，说明本插件最近一次放在模型面前的是什么，仅从消息窗口推导：

| 文本 | 何时 |
| --- | --- |
| `已提醒待办` | 清单有开放项且最新消息不是待办结果——下一个请求携带提醒 |
| `未提醒` | 最新消息*就是*待办结果（该请求的提醒被抑制），或没有开放项 |
| `暂无待办`（代替状态行） | 完全没有清单 |

面板只报告消息窗口能证明的东西，不编造它兜不住的标签：服务半区的催更计数器对 TUI
半区不可见（两者分属不同存储域），所以"已提醒*且已更新*"这类更丰富的措辞被刻意放弃。
它读取当前会话消息窗口里已有的最新 `focus_todo` 工具结果并渲染。不写、不轮询、没有
弹窗和设置，也不添加第二份清单。颜色跟随当前主题（标记行以弱化色绘制），超长行按
显示列宽裁剪到面板宽度，CJK 文本对齐不乱。

若未来 OpenCode 改动内部 TUI API，面板退化为惰性，工具照常工作——侧边栏从来不是
工具运转的前提。

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
  没有它插件行为完全一致（提醒每请求从 storage 重建）；若你开启了 billion-context 的
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
bun test                       # 172 个单元测试，含一个带种子的不变量扫描
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
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus 2 active" "已提醒待办" "!active, done"
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus: all done" "未提醒"
node verify/drive-capture.mjs <clear后的sessionID> --min-col=150 "暂无待办" "!Focus" "!已提醒待办"
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
