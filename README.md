# dsh-patch-keeper

**补丁包管家** —— 让你在第三方项目上的魔改，永远跟得上官方更新。

| | |
|---|---|
| 形态 | hybrid（host 工具 + 守护循环 + Web GUI 设置面板） |
| 版本 | 0.2.1 |
| 依赖 | 零外部依赖，纯 JS 实现（自带 LCS diff 引擎，不依赖 git） |
| 平台 | DSH Desktop / 任何装配了 `tools` `timer` `webServer` 服务的 Cordis 运行时 |

## 为什么需要它

你在网上下载的第三方插件/项目上加了自定义功能，但官方还在持续更新。每次官方出新版，
你的修改要么被覆盖、要么手工重做。本插件把这套循环自动化：

```
 注册项目 ──► 提取补丁包 ──► 守护循环盯官方
     │                            │
     │                      发现新版本 ⚠️
     ▼                            ▼
 「新官方+我的修改」◄── finalize ◄── AI 解决冲突 ◄── patch_merge 应用旧补丁到新版
      成品目录        生成新补丁包
```

- **提取**：对比「你的目录 vs 官方基线」，把差异存成 unified diff 补丁包（文本）+ 副本（二进制）
- **守望**：守护循环每 6 小时查一次 GitHub Releases / npm registry，有新版即写入提醒
- **合并**：`patch_merge` 把旧补丁应用到新官方源码上——干净处自动应用，冲突处生成逐文件报告交 AI 处理
- **产出**：`patch_apply` 一键得到「新官方 + 你的全部修改」的成品目录

## 安装

标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。`dsh plugin` 会把参数转发给 pnpm，
并在成功后自动把 `dsh-patch-keeper` 加入对应 profile 的 `dsh.profile.bundles`
（同时应用本包 `cordis.patch.yml` 的名册 insert 层——这是桌面壳的硬性要求）。

### 方式 A：本地安装（从克隆的仓库）

```bash
dsh plugin --profile web add link:.
# 或指定绝对路径
dsh plugin --profile web add link:D:\你的路径\dsh-patch-keeper
```

- 安装完成后重启该 profile（如 `dsh web`），浏览器 F5 刷新
- **如果之后移动了源码目录**，必须重新执行一次 `dsh plugin --profile <name> add link:.<新路径>`；
  若提示已存在/冲突，先 `dsh plugin --profile <name> remove dsh-patch-keeper` 再重新 add

### 方式 B：npm 安装（已发布到 npm）

```bash
dsh plugin --profile web add dsh-patch-keeper
```

### 给 AI 的安装说明（用 dsh 辅助安装时，直接复制给 AI）

```markdown
请帮我安装插件 dsh-patch-keeper，来源是 GitHub 仓库 Frankiesondesu/dsh-patch-keeper。
1. 确保 pnpm 可用（没有就先：npm install -g pnpm）
2. 在目标 profile 安装（以 web 为例）：
   dsh plugin --profile web add dsh-patch-keeper
   如果要从本地克隆的仓库根目录链接安装，则用：
   dsh plugin --profile web add link:.（在仓库目录内执行，或 link:<仓库绝对路径>）
3. 验证：dsh --profile web --dump-config 应能看到 dsh-patch-keeper 在 bundles 里；
   重启后 Web GUI「设置 → 🩹 补丁包」分区与 9 个 patch_* 工具出现即成功。
```

### 卸载 / 升级

```bash
dsh plugin --profile web remove dsh-patch-keeper   # 卸载
dsh plugin --profile web update dsh-patch-keeper   # 更新到 npm 最新版
```

### 开发态（免重启注入）

```bash
dev_inject_plugin {"dir": "<本目录>"}
```

安装后即出现 9 个 `patch_*` 模型工具 + 设置面板分区 + `/patch-keeper/api` 路由。

## 快速开始

```jsonc
// ① 注册一个你改过的项目（自动从 .git/config 探测上游，优先 upstream 远程）
patch_init {
  "name": "my-plugin",
  "modifiedDir": "D:\\code\\my-plugin",
  // "upstream": "github:someone/my-plugin",   // 无 git 时手动指定（支持 npm:包名）
  // "ignore": ["exported", "doc/images"]     // diff 排除项
}

// ② 提取补丁包（officialDir 不传则按基线 ref 从上游拉取官方源码，首次可能数分钟）
patch_extract { "name": "my-plugin" }

// ③ 之后交给守护循环；发现新版本后让 AI 执行「合并闭环」（见下节）
```

## AI 合并闭环（核心价值）

官方更新后，把下面这段提示词直接丢给任意 AI 会话即可完成升级：

```markdown
请把补丁包 <id> 升级到官方最新版：
1. 先读 C:\Users\<user>\.dsh\patch-keeper\projects\<id>\patch\main.patch，
   总结我现有每处修改的意图；
2. 运行 patch_merge {"name":"<id>"} —— 干净处自动应用，冲突文件生成报告；
3. 对每个冲突文件，结合「我的修改意图 + 新官方代码现状」写出合并结果，
   存入一个新建目录（保持项目内相对路径）；
4. 运行 patch_finalize {"name":"<id>","resolvedDir":"<该目录>"}；
5. 用 patch_apply 产出到临时目录抽查关键修改点是否存活，最后 patch_status 汇报。
注意：merge/finalize 需联网拉取官方源码，单步可能数分钟，请轮询等待不要放弃。
```

无冲突时第 3 步可省略（finalize 直接调用）。也可以在 GUI 里点「⚡ 合并到新版」，
面板会逐文件展示冲突详情并把工作区路径喂给 AI。

## Web GUI 面板

**设置 → 「🩹 补丁包」分区**：

- 项目总览：基线 → 最新版本、补丁版本、上游、最近检查时间；⚠️ = 官方有更新
- 一键操作：检查更新 / 提取补丁 / 合并到新版 / 生成成品 / 移除（二次确认）
- 合并工作台：逐文件展示冲突（旧 hunk + 新官方上下文），填入解析目录一键 finalize
- 注册表单、更新提醒（可清空）、运行日志尾部查看

长操作走内置任务队列：点击立即返回，面板每 2 秒轮询 `/jobs`，完成后自动刷新并播报。

## 模型工具参考

| 工具 | 必填参数 | 可选参数 | 说明 |
|---|---|---|---|
| `patch_init` | `name` `modifiedDir` | `officialDir` `upstream` `ignore` | 注册项目；记录基线版本/ref、探测上游；传 officialDir 则立即提取 |
| `patch_extract` | `name` | `officialDir` `ref` | 重提补丁包（本地改动后刷新用） |
| `patch_check` | — | `name` | 检查官方更新（省略 name = 全部），结果写入提醒 |
| `patch_merge` | `name` | `newVersion` `newOfficialDir` | 旧补丁应用到大板新版；返回 `{applied[], conflicts[]}` |
| `patch_finalize` | `name` | `resolvedDir` `resolved` | 合入冲突解析 → 生成新补丁包 → 归档旧补丁 |
| `patch_apply` | `name` `targetDir` | `version` `officialDir` | 产出「官方+修改」成品目录；返回存活/冲突统计 |
| `patch_status` | — | `name` | 全项目状态表（⚠️ = 待更新） |
| `patch_remove` | `name` | `confirm:true` | 移除注册及补丁数据（不动你的项目目录） |
| `patch_notifications` | — | `clear:true` | 查看/清空更新提醒 |

`upstream` 取值：`"github:owner/repo"` / `"npm:包名"` / `{type:"github",owner,repo}` 对象。
GitHub 项目优先走 releases API（未认证限 60 次/时）；npm 项目走 registry。

## HTTP API 参考（前缀 `/patch-keeper/api`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | 项目状态汇总 `{projects[], pending}` |
| POST | `/check` `/extract` `/merge` `/finalize` `/apply` `/init` | 长操作 → `{jobId}` 立即返回 |
| POST | `/remove` `{name, confirm:true}` | 移除注册（同步返回） |
| GET | `/jobs` | 任务队列（前端轮询用） |
| GET | `/merge-latest?name=` | 最近一次合并记录（含裁剪后的冲突报告） |
| GET | `/notifications` · POST `/notifications/clear` | 更新提醒读取 / 清空 |
| GET | `/log?lines=60` | 运行日志尾部 |

任务结果统一落在 `GET /jobs`：`{status: done|error, result, error}`。

## 配置

在 loader 行的 `config` 中可调：

```yaml
- id: dsh-patch-keeper
  config:
    initialCheckDelayMs: 60000   # 启动后首次检查延迟（≥10000）
    checkIntervalMs: 21600000    # 守护循环检查间隔（默认 6 小时）
```

## 数据存储

```
~/.dsh/patch-keeper/
  projects/<id>/manifest.json   项目清单（基线/上游/补丁版本/更新状态）
  projects/<id>/patch/main.patch unified diff 补丁包
  projects/<id>/patch/meta.json  变更文件清单（含删除项）
  projects/<id>/patch/bin/       二进制变更副本
  merge/<id>/m-*/               合并工作区（official 快照 + merged 树 + 冲突报告）
  archive/<id>/                  旧补丁归档
  notifications.jsonl            更新提醒
  patch-keeper.log               运行日志
```

## 设计说明与已知边界

- **diff 引擎**为纯 JS（LCS + unified diff 生成/解析/应用），不依赖 git 可执行文件；
  二进制与大文件（>2MB）变更以副本形式入包。
- **忽略规则**：默认排除 `node_modules` `.git` `.venv` `__pycache__` `dist` `build` 等；
  项目级追加用 `patch_init` 的 `ignore`。
- **基线缓存**：从 GitHub 拉取的官方基线存于 `tmp/<id>-base`，完整则复用（防网络抖动重复下载）。
- **进程内下载失败时**（代理/CDN 差异导致 npm tgz 拉不全）：手动下载官方包解压后传
  `officialDir` / `newOfficialDir` 即可绕过。
- **源码即产物**：`lib/index.js`（host；`lib/main.js` 为入口同步副本）与 `lib/client.js`
  （GUI，`__ModuleLoader__` bundle 格式）均为手写纯 JS 直接维护，不经过 tsc/tsdown；
  `scripts/build.sh` 只做同步与语法自检——勿对 lib/ 跑编译覆盖。
- **热重载提示**：资源注册全部挂 `ctx.effect`，配合注入器热重载即插即净；
  `webServer` 已声明为硬依赖，避免服务就绪时序竞争。

## 版本历史

- **0.2.3** 首个 CI 自动发布版本：npm Trusted Publishing（OIDC）零令牌发布 + 自动 provenance；功能无变化
- **0.2.2** 按官方插件发布规范整备：包名更名 `dsh-patch-keeper`（去除 `@dsh-external` 作用域）、
  移除 `private` 支持 npm 发布、keywords 增加 `dsh-plugin`、新增 push 自动发布工作流；功能无变化
- **0.2.1** `webServer` 改为 inject 硬依赖（修复启动时序竞争导致的 API 静默禁用）
- **0.2.0** hybrid 化：Web GUI 设置面板 + `/patch-keeper/api` 任务队列路由；移除过时脚手架
- **0.1.0** 初版：9 个 `patch_*` 工具 + 守护循环（host-only）

## 发布流程（维护者）

手动修改 `package.json` 的 `version` → push 到 main → `.github/workflows/publish.yml`
自动执行：npm 未发布过该版本则 `npm publish`，并创建同名 `v<version>` GitHub Release
（changelog 自动汇总上一 tag 之后合入的 PR）。幂等：重复 push 同一版本自动跳过。

## 许可

[BSD-3-Clause](./LICENSE)
