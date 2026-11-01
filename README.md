# dsh-plugin-preflight

DSH 的**插件安装预检闸门**。装插件之前先核一遍规则，判定为「拒绝」就中止安装，并把每次尝试写进审计日志。

它不是市场，也不替你决定装什么——它只在你按下「安装」到 pnpm 真正执行之间，插一道检查。

## 它拦什么

九项规则，阈值全部在 [`policy.json`](policy.json)，代码里不含判断标准：

| # | 检查 | 阻断级 |
|---|---|---|
| 1 | GitHub 仓库存在、未归档、90 天内有推送 | ✗ 拒绝 |
| 2 | 无 `preinstall` / `install` / `postinstall` | ✗ 拒绝 |
| 3 | 未被 `deprecated` | ✗ 拒绝 |
| 4 | 直接依赖数 > 8 拒绝、> 1 警告 | ✗ / ! |
| 5 | 兼容宿主版本（`dsh.compatibility` / `engines.dsh` / peer 范围） | ✗ 拒绝 / ! 警告 |
| 6 | 自更新、热重载痕迹（脚本 / 依赖 / README） | ! 警告 |
| 7 | 是否要求第三方账号 | ? 需人工 |
| 8 | npm provenance 签名 | ! 警告 |
| 9 | 装后钉精确版本 | · 提醒 |

**只拦「明确拒绝」**：警告与需人工一律放行，交给人判断。

## 怎么工作

```
安装请求
   ↓
pluginManager.installBundle（被本插件包装）
   ↓
跑 scripts/preflight.mjs <包名> --json
   ↓
拒绝 → 抛错中止 + 写审计 + 在「安装详情」里贴一份结构化报告
通过 → 原样调用原方法
预检跑不成（断网 / 限流 / 超时） → 见下方三种处置
```

### 预检跑不成时怎么办

这是唯一可能被「绕过」的环节——如果一律放行，那么让网络卡住就成了绕过手段。所以默认**拦截**，并按以下顺序处置：

1. **30 分钟内验过同一个包** → 沿用上次结论（`verdict-cache.json`），不重复联网；
2. **没缓存且策略为 `block`（默认）** → 中止安装，报告里写明原因与三种处置办法；
3. **策略为 `allow`** → 放行，审计记 `unverified`，界面不提示成功。

策略在面板「高级设置 → 预检跑不完时」切换，热生效。离线环境建议选「放行」，否则装不了任何东西。

**注意**：这是「安全」与「可用」的取舍，没有两全。默认拦截的代价是断网时装不了插件；默认放行的代价是网络异常等于没设防。

## 安装

桌面端：插件页 →「添加插件」→ 填 `dsh-plugin-preflight`（已发布时）或本目录的绝对路径 → 重启。

命令行（仅纯 web profile）：

```bash
dsh plugin --profile web add dsh-plugin-preflight
```

## 配置

`cordis.patch.yml` 里的 `config`（整块替换，改一个键要重述其它键）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `enforce` | 启动默认模式；运行期以 `runtime.json` 为准 |
| `dataDir` | 空 | 数据目录。空时回退 `workspaceRoot/docs/audit`，再回退 `~/.dsh/plugin-guard/audit` |
| `workspaceRoot` | 空 | 旧配置兼容用，建议新装时改用 `dataDir` |
| `timeoutMs` | `20000` | 单次预检超时 |

`runtime.json` 里可热改的项（面板「高级设置」写的就是它）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `enforce` | `enforce` 拦截 / `warn` 只记录 |
| `onUnverified` | `block` | 预检跑不成时：`block` 拦截 / `allow` 放行 |
| `timeoutMs` | `20000` | 预检超时（毫秒） |
| `auditMaxBytes` | `1048576` | 审计文件上限，超过轮转，保留 3 份旧日志 |
| `disabledRules` / `allowlist` / `thresholds` / `customRules` | 空 | 见上文 |

**它放在数据目录，不在安装目录**（0.15.0 起）：`dataDir` → `workspaceRoot/docs` → `~/.dsh/plugin-guard`，与审计同一处。
写在安装目录会导致升级插件时设置被 pnpm 重装覆盖、只读安装则根本写不进去。旧版本留下的 `runtime.json` 会被自动读取，改一次设置后即迁到新位置。

## 自定义规则

内置九条之外，可以自己加检查。规则写在 `runtime.json` 的 `customRules`，或直接在面板「高级设置 → 自定义规则」里添加。

### 四个字段各管什么

| 字段 | 作用 | 边界 |
|---|---|---|
| **标题** `title` | 报告里显示的名字 | 必填。只影响显示，不参与判断 |
| **条件** `when` | 唯一的判断依据 | 必填。语法见下；写错会直接不生效（见「边界」） |
| **等级** `status` | 命中后算多严重 | `warn` / `reject` / `manual` 三选一，默认 `warn` |
| **说明** `detail` | 报告里那句人话 | 可空；支持 `{字段}` 占位，如 `只有 {repo.stars} star` |

四者是**与**的关系：条件命中 → 按等级追加一条结果 → 显示标题与说明。**不命中就什么都不发生**，不会出现在报告里。

### 条件语法

```
字段  比较符  值
```

- 比较符：`<` `>` `<=` `>=` `==` `!=`
- 值：数字 `100`、字符串 `"abc"` 或 `abc`、布尔 `true` / `false`
- 多个条件用 `&&`（与）、`||`（或）连接；**`&&` 优先，不支持括号**

```
repo.stars < 50
repo.idleDays > 180 && repo.stars < 100
author == "someone" || name == "bad-pkg"
deprecated == true && provenance == false
deps contains "axios"
npm.weeklyDownloads < 100
```

数组字段（`deps` / `scripts` / `keywords`）用 `contains` 判断包含，其余字段用比较符。

### 可用字段（全部来自预检收集到的事实）

| 字段 | 类型 | 含义 | 数据来源 |
|---|---|---|---|
| `repo.stars` | 数字 | star 数 | GitHub API |
| `repo.idleDays` | 数字 | 距最后一次推送的天数 | GitHub API |
| `repo.archived` | 布尔 | 是否已归档 | GitHub API |
| `repo.found` | 布尔 | 是否找到仓库 | 元数据 / README 推断 |
| `repo.slug` | 字符串 | `owner/repo` | 同上 |
| `repo.forks` | 数字 | fork 数 | GitHub API |
| `repo.openIssues` | 数字 | 未关闭 issue 数 | GitHub API |
| `repo.license` | 字符串 | 仓库许可证 SPDX | GitHub API |
| `depsCount` | 数字 | 直接依赖数 | npm 元数据 |
| `deps` | 数组 | 依赖名列表（用 `contains`） | npm 元数据 |
| `scripts` | 数组 | 脚本名列表（用 `contains`） | npm 元数据 |
| `scriptsCount` | 数字 | 脚本数 | npm 元数据 |
| `keywords` | 数组 | 关键词（用 `contains`） | npm 元数据 |
| `keywordsCount` | 数字 | 关键词数 | npm 元数据 |
| `hasInstallScript` | 布尔 | 是否有 install 类脚本 | npm 元数据 |
| `deprecated` | 布尔 | 是否已弃用 | npm 元数据 |
| `provenance` | 布尔 | 是否有 npm provenance 签名 | npm 元数据 |
| `name` / `version` | 字符串 | 包名 / 版本 | npm 元数据 |
| `hostVersion` | 字符串 | 当前宿主版本 | 宿主注入 |
| `license` / `author` / `description` / `source` | 字符串 | 元数据 | npm 元数据 |
| `npm.weeklyDownloads` | 数字 | 最近一周下载量 | npm downloads API（**仅当规则用到才查**） |

### 边界（会踩的地方）

| 情形 | 实际行为 |
|---|---|
| **字段名写错** | **保存时直接拒绝**，提示「未知字段「repo.star」，可用字段：…」。不会再留一条永不命中的规则 |
| 条件语法不合法（缺比较符等） | 保存时拒绝，提示「无法解析的条件」 |
| 对数组字段做比较（`keywords` / `deps` / `scripts`） | 恒为 false——暂不支持 `in` / `contains` |
| 字符串比较 | 区分大小写；`==` 对数字与字符串都按字面比 |
| 同一字段用不同表示 | `deprecated == true` 可以，`deprecated`（裸写）不行——必须有比较符 |
| 多条自定义规则 | 互相独立，**都要评估**；命中几条就追加几条 |
| 等级 | 决定结论：`reject` > `manual` > `warn` > `pass` |
| 与内置规则冲突 | 不会覆盖内置规则，只会叠加；内置规则说拒绝，自定义规则说通过，结论仍是拒绝 |
| 关掉某条自定义规则 | 从 `customRules` 里删除即不再评估（面板上点 ✕） |

### 一条完整示例

```json
{
  "id": "custom-abc123",
  "title": "冷门仓库",
  "when": "repo.stars < 50 && repo.idleDays > 90",
  "status": "warn",
  "detail": "{repo.slug} 只有 {repo.stars} star，且已 {repo.idleDays} 天没更新"
}
```

命中后报告会多一行：

```
! 冷门仓库：owner/repo 只有 12 star，且已 210 天没更新
```

## 运行期开关（热生效，无需重启）

侧栏「插件预检」面板里切换，或直接改 [`runtime.json`](runtime.json)：

```json
{ "mode": "warn" }
```

- `enforce`：预检拒绝时中止安装
- `warn`：照常安装，只写审计

**包里的 `cordis.patch.yml` 不写绝对路径**；要固定数据位置，在你自己的 profile 补丁里覆盖 `plugin-guard` 行。

## 数据在哪

默认在 `~/.dsh/plugin-guard/`（可用 `dataDir` 或 `workspaceRoot` 改）：

| 文件 | 内容 |
|---|---|
| `runtime.json` | 运行期配置（模式、阈值、自定义规则） |
| `audit/plugin-guard.jsonl` | 每次安装尝试一行（含放行、拦截、无法验证） |
| `audit/last-block.md` | 最近一次拦截的人可读说明 |
| `audit/last-block.json` | 同上，结构化副本，供面板读取 |

## 自测

```bash
node scripts/selftest.mjs
```

36 项断言，覆盖：通过放行、拒绝拦截、警告放行、预检失败默认拦截、策略放行、本地路径跳过、模式热切换（warn→放行→enforce→再拦）、卸载还原、审计落盘与去重、审计轮转、请求准入（DNS rebinding / 局域网 / Origin）、降级时仍然拦截、运行期配置落在数据目录、结构化报告、自定义规则校验（未知字段 / 语法错 / 非法等级 / 缺标题 / contains）。

不联网、不起子进程（预检用桩函数注入）。

> 自测只随 GitHub 仓库提供，不进 npm 包（`files` 里不含它）。

## 发布清单

包名已改为 `dsh-plugin-preflight`（无作用域、无 `private`），可直接 `npm publish`。

发布前按顺序核对：

1. **先跑自测**：`node scripts/selftest.mjs`（应全绿），并把 `package.json` 版本与 CHANGELOG 最新条目对齐；
2. **`npm pack --dry-run` 看清单**：确认 `files` 里是 11 项、无 `node_modules`、无 `docs/audit` 等运行期数据；
3. **干净 profile 实装**：不要在自己日常用的 profile 上试首次发布，新建一个临时 profile 装一遍；
4. `npm publish`（无作用域包直接发；若改回 scope 需 `--access public`）；
5. 发布后去市场申请收录（dshmarket 界面右上角「申请收录插件」）。

**发布过就要维护**：宿主还在 `0.2.x-rc` 阶段，内部结构会变。每次 DSH 大版本升级后，都要回来确认 `capabilities` 探测是否仍全绿。

**版本纪律**：每次改行为都要同时动 `package.json` 的 `version` 和 CHANGELOG 对应小节——这个仓库曾出现 `package.json` 停在 0.3.0、CHANGELOG 已到 0.9.2 的漂移。

## 已知限制

- **依赖宿主未公开的内部结构**：`pluginManager.installs`、`plugin-manager/install-log` 事件、`sidebar.panellist` 槽位。宿主升级后可能静默失效——失效时闸门仍会拦截，只是界面提示与统计可能缺失。启动时会探测并告警，面板顶部也会显示「兼容性降级」。
- **只覆盖走 `pluginManager.installBundle` 的安装**。插件页「添加插件」与 dshmarket 市场走这条通道（已实测）；CLI `dsh plugin add`、手改 `package.json` + `pnpm install` 绕得过去。
- 第 6、7 条是关键词启发式，会漏也会误报。
- 预检跑不成时默认拦截，离线环境需把策略改成「放行」。
- **接口准入只防远程**：本机进程可直接改 `runtime.json`，HTTP 层挡不住。

## 跨平台

| 平台 | 状态 |
|---|---|
| Windows | 实测（开发与验证环境） |
| macOS / Linux | **未实测**，但已消除静态平台假设 |

已确认没有的平台假设：

- 生产代码里无 `pwsh` / `powershell`、无 `process.platform` 分支、无写死盘符路径（`[a-zA-Z]:[\\/]` 只用于「判断是不是本地路径」的正则，跨平台通用）；
- 数据目录用 `os.homedir()`，路径全部走 `node:path`；
- 解释器回退链：配置指定 → 宿主 node → 若宿主是 Electron，用 `ELECTRON_RUN_AS_NODE=1` 跑自己（macOS 桌面端可能没有 `node` 在 PATH 上，这条是关键）。

仍未验证的部分：macOS 桌面壳的 resources 路径、`link:` 依赖在 Unix 上是 symlink 而非 junction。

## 许可

MIT
