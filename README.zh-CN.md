# dsh-commandcode-quota

**在 DeepSeek Harness 侧边栏看 Command Code 套餐额度** —— 5 小时 / 每周 / 月度三条额度窗口，渲染在「设置」正上方。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#参与贡献)

[English README](README.md) | **简体中文**

![侧边栏里的额度卡片，浅色与深色](assets/screenshot.png)

---

## 为什么做这个

Command Code 的套餐便宜，但额度被拆成三个互相独立的窗口，而唯一能看到它们的地方是官网。如果你像本插件的作者一样，把 **GOAT** 套餐接到 DeepSeek Harness 里写代码，那在请求失败之前，你根本不知道自己离上限还有多远。

这个插件把三条窗口放到你本来就会看的地方——侧边栏底部、「设置」正上方。一眼就能看到，不用再开一个浏览器标签页。

## 它显示什么

| 窗口 | 含义 | GOAT 套餐的值 |
|---|---|---|
| **5 小时** | 滚动突发限制，防止一次长会话抽干整月额度 | `$14` |
| **每周** | 滚动 7 天限制 | `$35` |
| **月度** | 本计费周期的额度总额 | `$70` |

**最短的窗口排最上面**，最紧的约束落在视线第一落点上。每行显示：

- **已用百分比**作为主值，按紧急度着色（< 60% 绿、< 85% 黄、更高红）；
- 同色的**满宽进度条**；
- 一个灰底胶囊显示**重置倒计时**（`59m` / `6d9h` / `8d1h`），不用点也不用算。

点击卡片展开：月度额度金额、剩余金额、本周期用量统计。把侧边栏收成导轨时，卡片缩成一个 36px 圆徽，显示**最紧的那条**窗口的百分比。

卡片上的一切都来自**你账号自己的数据**——窗口数量、上限、百分比都是接口读出来的，不做假设。接口没上报滚动窗口的套餐（比如按量付费的 **Provider**）就不画行。Go / GOAT / Pro / Max / Provider / Teams 都适用。

### 刻意不做的几件事

侧边栏的内容宽度只有约 200px，笔记本屏上小字会更小。所以卡片是把一个问题回答好——**我用到什么程度了**——而不是把接口返回的东西全摆出来：

- **只给月度金额。** 5 小时和每周窗口是"能不能用"的闸门，不是预算；这两行的金额对用户没有任何可执行的信息，还把真正要紧的数字挤出了视线。悬停时每行的精确金额仍然在。
- **不做配速判断、不做消耗速度预测。** "超速"对一个有活要干的人没有任何意义；预测耗尽时间则假设消耗匀速，而实际从来不是。数据层仍然在 JSON 里提供 `projection`，供命令行工具和脚本使用。
- **一次点击，五行结束。** 展开面板就是月度的"已用 / 剩余"加本周期统计。

### 为什么卡片不用等

首屏过去要等完一整趟上游往返，而刚重启的 dsh 没有任何缓存——这就是"要过一会儿才出来"。用 `preview/latency.mjs` 对线上接口实测：

| | |
|---|---|
| 重启后首个响应（磁盘有快照） | **约 2ms** |
| 重启后首个响应（首次运行、无快照） | 约 1.4s |
| 四个端点串行请求 | 约 2.3s |
| 四个端点同时请求 | 约 1.2s |

所以宿主端做了两件事：四个端点**同时发**（`whoami` 原来是单独 `await` 的，为了拿一个个人账号根本不上报的 org id，白等约 590ms），以及**把最近一次成功报告存到磁盘**。冷启动时路由立刻返回这份快照（变灰并标注"上次成功多久前"，同时后台已经在拉新数据），一秒后卡片换成实时值。浏览器收到快照后 3 秒就再问一次，而不是等常规的一分钟——你看完数字的时候它已经是实时的了。

### 数字口径

百分比由线上接口实时算出：`已用 ÷（已用 + 剩余）`，`preview/e2e-live.mjs` 可以随时对真实账号断言这个恒等式。行首主值按**整数百分比**取整——和 Command Code 官方面板的取整方式一致，所以卡片和官网数字永远对得上；精确到一位小数的百分比和金额都在悬停提示和展开面板里。

这也解释了"官网显示 100%、精确值其实是 99.84%"的现象：同一份数据，两种取整。如果哪天两边差得超过取整误差，说明口径出了问题——`已用 + 剩余 = 总额` 这个恒等式就是为了抓住这种情况。

月度总额是**两个端点**的数字相加得来的。恰好跨计费周期或换套餐的那一瞬（每月几百毫秒的窗口），这两个数会分属两个周期，相加的结果看起来很正常、实际能差出几十个百分点。套餐的名义额度就是这个校验的标尺（真实总额与它只差零点几个百分点）；一旦读数没过这道校验，宿主会标 `capSuspect: true` 并且**不给任何百分比**，卡片显示原因而不是数字，下一次刷新自动校正。

## 环境要求

- **DeepSeek Harness** `^0.1.5-rc.1`。插件依赖若干尚未稳定的框架内部接缝，见[兼容性](#兼容性)。
- 一个**有 API 权限**的 Command Code 账号（除 $1 的 **Go** 档外都包含）。
- Node.js 18+（只有可选的命令行工具需要）。

## 安装

### 1. 把包装进 profile

```sh
# 直接从 GitHub 装
dsh plugin --profile web add github:Jovan1666/dsh-commandcode-quota

# 或者从本地克隆装
git clone https://github.com/Jovan1666/dsh-commandcode-quota
dsh plugin --profile web add ./dsh-commandcode-quota
```

`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，所以包名必须能从 `$DSH_HOME/profiles/web/node_modules` 解析到。

### 2. 注册插件行

`dsh plugin add` **只装依赖，不组合插件**。往 `$DSH_HOME/profiles/web/cordis.patch.yml` 加一个 insert 块：

```yaml
- insert:
    - id: commandcode-quota
      name: "dsh-commandcode-quota"
```

> `name` 要加引号，且必须和安装后的包名完全一致——loader 把它当模块说明符导入。

### 3. 重启并刷新

停掉正在跑的 `dsh web` 重新启动，然后**刷新浏览器页面**。`window.__DSH_BOOT__` 是在页面被服务时注入的，页面加载之后才出现的插件不会被拉取。

### 备选：不用 pnpm 的手动安装

不想动 profile 的依赖图，就自己建链接再加同样的 insert 块：

```powershell
New-Item -ItemType Junction `
  -Path "$env:DSH_HOME\profiles\web\node_modules\dsh-commandcode-quota" `
  -Target "C:\path\to\dsh-commandcode-quota"
```

## 配置

**没有配置。** 装上就能找到你的凭据。

## 使用

| 操作 | 结果 |
|---|---|
| 看侧边栏底部 | 三条窗口、百分比、进度条、重置倒计时 |
| 点击卡片 | 展开月度额度、剩余金额、请求数与 token 统计 |
| 悬停某行 | 精确的 `已用 / 总额`、剩余额度、一位小数百分比、绝对重置时刻 |
| 收起侧边栏 | 卡片变成 36px 圆徽，显示最紧窗口的百分比 |
| 在对话里输入 `/quota` | 把同一份报告打印进对话 |

卡片每 60 秒刷新（任一窗口超过 85% 后提速到 15 秒），宿主半另有 15 秒缓存；`/quota` 命令读的正是卡片那份缓存报告，多敲一次命令不会多打上游接口。

## 凭据解析

API key 不会进浏览器。宿主半按下面的顺序解析，命中即停，报告里的 `credentialSource` 会告诉你实际用了哪一条：

1. 显式传入的 key（命令行的 `--key`）。
2. **从你自己的 `$DSH_HOME/settings.yaml` 发现**：任何 `baseURL` 指向 `commandcode.ai` 的 provider 路由。读该路由上的字面 `apiKey` 或它的 `apiKeyEnv`，再拿这个名字去环境变量和 `$DSH_HOME/.credentials.yaml` 解析。发现到的地址**只取 origin**——额度端点在主机根路径 `/alpha/*` 上，而 provider 的 baseURL 带 `/provider/v1` 路径。
3. 环境变量：`COMMANDCODE_API_KEY`、`COMMAND_CODE_API_KEY`、`CMD_API_KEY`，再退到**任何名字里含 `commandcode` 的变量**。
4. `$DSH_HOME/.credentials.yaml`（`refs.<NAME>`）或 `~/.dsh/.credentials.yaml` 里的上述名字。
5. `~/.commandcode/auth.json`（官方 `command-code` CLI 的登录态）。

**第 2 步是给别人用的关键**：它跟随**你自己的** provider 配置，而不是写死某一种命名习惯。你已经把 Command Code 配成 DSH 的 provider（设置 → Models）的话，什么都不用再做。

## 兼容性

插件依赖若干尚未成为稳定公开 API 的框架接缝，每一条都对着 `dsh 0.1.5-rc.1` 的真实实现：

| 接缝 | 用途 |
|---|---|
| `sidebar.footer.action` 插槽 | 「设置」上方那个位置，两种侧边栏宽度下都成立 |
| `ctx.slots.register({ name, id, order, inject }, Component)` | 贡献卡片 |
| `ctx.connection.rpc.call(channel, endpoint, payload, signal)` | 浏览器侧的请求 |
| `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` | 宿主侧的路由 |
| `ctx.get('commands')` + `commands.register({ name, description, handler })` | 可选的 `/quota` 斜杠命令 |
| `dsh.client` 清单 + `exports["./client"]` | 客户端 bundle 发现，服务于 `/plugins/<id>/client.js` |

> **为什么用精确 Fetch 路由而不是 `connection.rpc.handle`？** `rpc.handle` 挂载通道走的是 `owner.webServer`，而 `owner` 是 Connection 服务自己的 context——那里永远没注入 `webServer`。任何其他插件调用它都会抛 `cannot get property "webServer" without inject`，调用方 inject 什么都没用。`connection.fetch.register` 只写内部路由表，任何插件 fiber 都能用，而且天然继承共享 `/api` 传输的 Host/Origin 校验与浏览器会话 Cookie。

未来 dsh 版本改动其中任何一条，插件会在加载时明确报错，而不是静默渲染空白。

## 命令行工具（可选）

同一份数据层也提供零依赖的只读命令行，适合无 GUI 的机器或查看第二个账号：

```sh
node cli/cli.mjs              # 渲染一次
node cli/cli.mjs --watch 60   # 每 60 秒刷新
node cli/cli.mjs --json       # 归一化 JSON，给脚本消费
node cli/cli.mjs --help
```

```text
Command Code · GOAT（individual-goat）                          Jovan1666
────────────────────────────────────────────────────────────────────────
5 小时     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 1.4%
           今天 21:55 重置（3 小时 30 分后）
每周       ████░░░░░░░░░░░░░░░░░░░░░░░░ 12.8%
           09-24 01:51 重置（6 天 7 小时后）
月度额度   ████████████████████████████ 99.8% · $70.11 / $70.23
           剩余 $0.11 · 09-25 17:08 重置（7 天 22 小时后）
────────────────────────────────────────────────────────────────────────
本周期  18,087 请求 · 成功率 100% · in 3.49B / out 16.77M tokens
```

参数：`--json` / `--watch [秒]` / `--ascii` / `--color` / `--no-color` / `--base <url>` / `--timeout <ms>` / `--key <key>`。

命令行工具跟卡片同一套取舍：金额只给月度，不做配速判断和消耗预测（那些数字仍在 `--json` 里，给脚本用）。

错误码（退出码 2）：`MISSING_CREDENTIAL`、`AUTH`、`NOT_FOUND`（通常是套餐不含 API 权限）、`RATE_LIMIT`、`SERVICE`、`NETWORK`、`BAD_RESPONSE`、`USAGE`。

## 排查

| 现象 | 原因与处理 |
|---|---|
| 重启后完全没有卡片 | insert 块没加，或 `name` 和安装的包名不一致。用 `dsh --profile web --dump-config` 确认行在里面。 |
| 卡片出现但显示错误 | 宿主路由失败。悬停卡片看消息里的错误码：`MISSING_CREDENTIAL` 是没找到 key；`404` 通常是套餐不含 API 权限。 |
| `/plugins/dsh-commandcode-quota/client.js` 返回 404 | 客户端 bundle 没被组合。确认 `package.json` 里有 `dsh.client.platform === "web"` 和 `exports["./client"]`。 |
| 改了 `client.js` 没生效 | bundle 每请求现读磁盘，刷新页面即可；但如果改的是 `index.js` 或 `quota.mjs`，Node 已缓存模块，必须重启 `dsh web`。 |
| 全是 `—` | 账号没上报任何窗口（按量付费套餐），或报告还在加载。 |

## 隐私

- API key 只留在宿主端。浏览器拿不到 key，只通过同源 `/api` 传输收到归一化报告，而该传输另外还限制在 loopback 并要求本进程的浏览器会话 Cookie。
- 只和你的 Command Code 账号 API 通信。没有遥测、没有统计、没有第三方端点。
- 本地唯一写入的文件是最近一次报告的磁盘快照：`$DSH_HOME/dsh-commandcode-quota/last-report.json`。它存的就是卡片上那些数字（额度总额与各窗口用量，**不含 API key**），存在的意义是让卡片在重启后立刻出现。随时可以删掉，插件会重建。它同时也是卡片秒开的原因，所以并没有多写任何你没在屏幕上见过的东西。
- 除这个快照外，每次刷新都是对四个只读端点的实时读取。
- 本地只读上面「凭据解析」里列出的凭据与设置文件。

## 工作原理

```mermaid
flowchart TD
  A["client.js — 注册进 sidebar.footer.action 插槽"] --> B["ctx.connection.rpc.call('/api', 'cc-quota/report')"]
  B -->|"POST /api/cc-quota/report"| C["index.js — ctx.connection.fetch.register(...)，15 秒缓存"]
  C --> D["quota.mjs — 解析凭据，然后读四个 /alpha/* 端点"]
  D -->|"Bearer api key"| E["api.commandcode.ai/alpha/*"]
```

| 文件 | 作用 |
|---|---|
| `client.js` | 浏览器半：卡片、样式表、轮询 hook。手写 bundle，无构建步骤，因此用 `React.createElement` 而非 JSX，并且只从前端的静态模块表取 `react`。 |
| `index.js` | 宿主半：共享 `/api` 传输上的一条精确 Fetch 路由，以及响应缓存。 |
| `quota.mjs` | 数据层：凭据发现、四个只读端点、归一化成与展示无关的报告。插件与命令行共用。 |
| `cordis.patch.yml` | profile 组合时加载插件用的 insert 块。 |

上游端点（全部只读 `GET`，Bearer 鉴权）：

| 端点 | 用到的字段 |
|---|---|
| `/alpha/whoami` | 账号身份、`org.id` |
| `/alpha/usage/summary` | `totalCredits`（本周期已用）、请求数、成功率、tokens |
| `/alpha/billing/credits` | `credits.monthlyCredits`（剩余）、`windowLimits.fiveHour` / `.weekly` |
| `/alpha/billing/subscriptions` | `planId`、`status`、`currentPeriodStart/End` |

四个端点各自独立降级：单个失败只记进报告的 `failures`，其余照常渲染；四个全失败才抛错，并带上最具体的错误码。

## 开发

```sh
# 1. 只有组件测试和预览页需要 React
mkdir .devdeps && cd .devdeps
npm init -y && npm install react@18 react-dom@18
cd ..

# 2. 一次跑完全部 —— 110 项，一个结论，不碰网络也不读真实凭据
node scripts/verify.mjs          # 加 --live 会额外打真实账号
node scripts/verify.mjs --quiet  # 每个套件只打一行汇总

#    它依次运行（也可单独跑）：
#    tests/quota.test.mjs     15  路由发现、凭据顺序、套餐表
#    tests/host.test.mjs      26  路由注册、缓存新鲜度、并发去重、磁盘快照、信封校验、/quota
#    tests/client.test.mjs    43  插槽注册、版式规则、各渲染状态、变化中的数值、陈旧快照
#    tests/dynamic.test.mjs   26  账号变化中的数据不变量：漂移、重置、跨周期读数、读取路径形态

# 3. 可选：确认没有凭据或本机路径被提交
node scripts/audit.mjs
```

### 拿真实账号校验数字

离线套件用的是构造序列，下面两个脚本校验真实数据：

```sh
# 首屏时间到底花在哪：各端点耗时 + 冷启动对比
node preview/latency.mjs

# 一次性：打印 /quota 文本，并断言 已用 + 剩余 = 总额
node preview/e2e-live.mjs

# 动态校验：反复采样真实账号，断言数字在变化中依然自洽——跨字段恒等式、
# 百分比由同一组数字重算、无 NaN、计数器单调不回退（周期切换或窗口重置
# 是唯一合法的"变小"理由）
node preview/e2e-watch.mjs 6 20      # 采样 6 次，间隔 20 秒
```

`e2e-watch` 一旦发现不变量被破坏就以非零码退出；如果这一轮什么都没变，它会**明说这一轮没证明到漂移**，而不是假装验过了。

### 不重启 dsh 也能预览卡片

为了调样式去重启正在跑的 `dsh web` 太慢。`preview/build.mjs` 把**真实的 `client.js`** 渲染进一个仿真侧边栏（真实主题 token、浅色/深色、折叠/展开三列并排），再用 Chrome 无头模式截图。`--virtual-time-budget` 不能省：展开那一列是靠定时器里的脚本点击展开的，不给它跑完，截到的全是折叠态。

```sh
node preview/build.mjs
chrome --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=816,470 --virtual-time-budget=5000 \
  --screenshot=preview/shot.png "file://$PWD/preview/index.html"

# 把输出换成 assets/screenshot.png 就是 README 头图
```

主题 token 是从已安装的 `dsh-client-ui-theme` bundle 里**合并全部** `body{}` 与 `body[data-ds-dark-theme]{}` 块提取的。只取最后一块会漏掉 `--dsw-alias-state-*`，让所有进度条变透明——这个坑本仓库踩过一次。

## 已知限制

- **轮询而非推送。** 面板 60 秒刷新一次（宿主 15 秒缓存），任一窗口超过 85% 后提速到 15 秒；额度变化最多滞后一分钟。
- **刻意不做消耗预测。** 卡片不估算"几天后耗尽"：消耗是突发的，一个忙碌的下午说明不了下周，而配速结论对有活要干的人也无可执行性。数据层仍然在 JSON 里提供 `projection`，供命令行工具和脚本使用。
- **没有按模型分配的明细。** Command Code 把月度额度按模型分配，但 `/alpha` 端点不暴露那张表，卡片只能给总额。
- **不记录历史。** 每次都是实时快照，本地不存任何东西。
- **只覆盖 Command Code。** 不替代 dsh 自己的本地 token 统计（那个在 `$DSH_HOME/dsh-usage/`）。
- **依赖框架内部接缝。** 见[兼容性](#兼容性)。

## 参与贡献

欢迎提 issue 和 PR。开 PR 前请先跑那三套离线测试，并保持样式只用 harness 的 `--dsw-alias-*` 设计 token——测试会断言样式表里没有字面色值。

## 致谢

端点契约与套餐表对照过 [`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT），那是同一服务的非官方 provider 插件。

## 许可

[MIT](LICENSE)
