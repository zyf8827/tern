# [ARCHIVED] Tern（北极燕鸥）E2E 测试平台历史技术方案

> **注意：本文档为历史归档技术设计稿（v0.5），已归档留存。**
> 现行系统架构设计与设计原则请参阅最新文档 [architecture.md](../architecture.md)。

| | |
|---|---|
| 版本 | v0.5（历史归档） |
| 日期 | 2026-09-17 |
| 代码库 | `tern` |
| 状态 | 历史归档 |
| 变更 | v0.5：**测试运行**取代「批次」——一次测试运行只归属一个 project，可覆盖该项目多个 version / tag；缺省全部空闲 worker 并行，也可指定一个。用例库与运行列表默认分页 20 条，运行支持 status/project/createdBy/worker/关键字/时间筛选。**Git 认证**：默认 HTTP 账号密码，可选 SSH 私钥；凭据写入项目记录（secret 不回显）；clone/fetch 用临时 ASKPASS / 私钥文件，禁用 ssh-agent 与宿主机 `~/.ssh`（容器内不可用宿主机密钥）。对外 API：`/api/v1/runs`（测试运行）、`/api/v1/executions`（单用例执行）。 |
| 变更 | v0.4：**用例项目仓库化**——用例不再维护在平台仓库内，改为「一个 git 仓库 = 一个 project」：Web 端添加 git 仓库自动 clone 到 `REPOS_DIR`（默认 `./repos`，已 gitignore），仓库根放 `tern.yaml` 描述项目 meta；默认定期强制拉取（`fetch + reset --hard + clean -fdx`，杜绝本地人工修改），页面可手动更新；也支持本地放置目录自动发现。**登录支持**——`tern.yaml` 声明 auth profiles（表单登录 / 调登录接口 / 直写 cookie+localStorage，凭据 `${ENV:VAR}` 占位符在 worker 端解析），用例 frontmatter `auth: <名字>` 引用，执行前生成 storageState 注入。**用例多维字段**——frontmatter 新增 `version` / `module`，与 tags、project 组成多维度筛选（API/CLI/MCP/Web facets）。**测试运行指定 worker**——创建运行可绑定 worker（id/名称），调度只派给该 worker |
| 变更 | v0.3：项目定名 **Tern**（北极燕鸥 Arctic Tern——一年往返两极约 7 万公里，动物界极致的 end-to-end）。CLI `e2ep` → `tern`，MCP 工具前缀 `e2e_` → `tern_`，环境变量 `E2EP_*` → `TERN_*`，用例标记 `@e2ep` → `@tern`，镜像 `e2ep-server/worker` → `tern-server/worker` |
| 变更 | v0.2：按评审意见，平台不自研「用例执行引擎」——用例改用**原生 Playwright Test 语法**编写，Worker 调起官方 playwright test runner 执行（临时生成 config + 事件 reporter + CDP 侧车 + 进程看护）。注意：**Worker 执行管理层（exec-kit）仍是平台自研的必备组件**，「不自研」仅指最底层的用例执行引擎 |

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [总体架构](#2-总体架构)
3. [技术选型](#3-技术选型)
4. [用例库规范（代码库即用例库）](#4-用例库规范代码库即用例库)
5. [数据模型](#5-数据模型)
6. [执行模型](#6-执行模型)
7. [实时能力](#7-实时能力)
8. [产物与文件存储规范](#8-产物与文件存储规范)
9. [API 设计](#9-api-设计)
10. [MCP 设计](#10-mcp-设计)
11. [Web 管理端](#11-web-管理端)
12. [Coding Agent 友好性设计](#12-coding-agent-友好性设计)
13. [代码仓库结构](#13-代码仓库结构)
14. [配置项](#14-配置项)
15. [安全模型](#15-安全模型)
16. [非目标与未来扩展](#16-非目标与未来扩展)
17. [里程碑与实施计划](#17-里程碑与实施计划)
18. [风险与开放问题](#18-风险与开放问题)

---

## 1. 背景与目标

### 1.1 一句话定位

一套**面向 Coding Agent 的 E2E 测试平台**：用例以普通源码文件的形式保存在 Git 仓库中，由人或 Coding Agent 直接编写；平台提供 Web 只读管理端、1-N 分布式 Worker 执行、测试运行调度、实时进度与远程浏览器画面（只读）、MCP 协议接口，让「写用例 → 跑用例 → 看结果 → 修问题」的完整闭环既可以由人完成，也可以完全由 Agent 完成。

### 1.2 核心设计原则

| # | 原则 | 含义 |
|---|------|------|
| P1 | **代码库即用例库** | 用例是 Git 仓库里的普通 TypeScript 文件，没有任何平台私有格式锁定；平台只是「发现」并索引它们 |
| P2 | **管理端只读** | Web 端不提供用例创建/编辑入口；所有用例变更走代码库 commit（人或 Agent） |
| P3 | **部署极简** | Server = 1 个 Node 进程 + 1 个 SQLite 文件 + 1 个数据目录；Worker = 1 个 Node 进程 + Playwright 浏览器。无消息队列、无外部依赖 |
| P4 | **Agent 优先** | 所有能力都有等价的 MCP 工具 / CLI / JSON API；ID 确定性可预测；输出机器可读；仓库内 `AGENTS.md` 作为 Agent 的第一入口 |
| P5 | **Worker 被动且自治** | Worker 只出站连接 Server、不监听端口；断线本地续跑、崩溃后由 Server 兜底重派 |

### 1.3 术语表

| 术语 | 含义 |
|------|------|
| Case（用例） | `cases/` 目录下的一颗 `*.spec.ts` 文件 |
| Case Bundle | 用例源码经 esbuild 打包后的自包含 JS，是执行下发的载体 |
| Run（测试运行） | 一次测试执行请求 + 被选中用例的快照。只归属一个 project，可覆盖多个 version / tag。库表仍名 `batches`（历史兼容） |
| Run Item | 运行中某条用例的执行槽位（含重试计数、状态机） |
| Execution | 一条用例的一次实际执行（重试会产生多条 execution 记录；库表 `case_runs`） |
| Worker | 执行进程，持有 Playwright 浏览器，接受 Server 调度 |
| Artifact（产物） | 执行产物：trace、截图、视频、日志等文件 |
| Sync（同步） | Server 扫描 cases 目录 → 校验 → 打包 → 入库的过程 |
| 执行管理层 | Worker 侧的执行编排层：领任务、组装运行目录与临时 config、调起执行引擎、超时看护、事件/实时画面采集、产物上传、断线重连。由 Worker 父进程 + exec-kit 构成，**平台自研、必备**（即通常所说的 worker 执行层，与 Agent harness 无关） |
| 执行引擎 | 真正执行一条用例的机制（超时/重试/截图/trace 的提供者）。v0.2 起直接复用官方 playwright test runner，平台不自研 |

### 1.4 需求追溯矩阵

| 原始需求 | 对应方案章节 |
|---|---|
| 1. Node + Playwright | §3 |
| 2. Web 管理用例，project 组织 + tag 属性 | §4、§5、§11 |
| 3. SQLite 存储 | §3、§5 |
| 4. 测试运行、tag 筛选、实时进度、远程浏览器只读观看 | §6、§7、§11 |
| 5. 失败自动截图 + 日志保存 | §6.4、§8 |
| 6. 文件类数据按规范目录组织 | §8 |
| 7. 管理端与 Worker 分离，支持 1-N Worker | §2、§6 |
| 8. Worker 被动等调度 + 异常管理 | §6.3、§6.5 |
| 9. 用例不经页面创建、页面只读、用例进 Git | §4、§11 |
| 10. MCP 协议支持 | §10 |
| 11. 面向 Coding Agent 友好 | §10、§12 |

---

## 2. 总体架构

### 2.1 架构图

```
   人（浏览器）          Coding Agent（MCP 客户端）        CLI / 脚本
       │                        │                            │
       ▼                        ▼                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Tern Server (:7430)                  │
│                                                                     │
│  ┌─────────┐  ┌────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Web UI  │  │ REST API   │  │ WS 网关       │  │ 用例同步器     │  │
│  │ (React, │  │ /api/v1    │  │ /ws/app       │  │ 扫描 cases/   │  │
│  │  静态)  │  │            │  │ /ws/worker    │  │ esbuild 打包  │  │
│  └─────────┘  └────────────┘  └──────────────┘  └───────┬───────┘  │
│  ┌──────────────────┐  ┌──────────────────┐     cases/ (Git)      │
│  │ 调度器 Scheduler │  │ 产物服务          │◀───────读取───────────┘
│  │ 队列/租约/重试/恢复│  │ /artifacts/*     │           │
│  └──────────────────┘  └──────────────────┘           ▼
│  ┌───────────────────┐                ┌─────────────────────────┐  │
│  │ SQLite (WAL)      │                │ data/bundles/<hash>.cjs │  │
│  └───────────────────┘                └─────────────────────────┘  │
└──────────┬──────────────────────────────────────────────┬──────────┘
           │ /ws/worker  (WebSocket 长连接, WORKER_TOKEN)   │ /artifacts (HTTP 上传/下载)
           ▼                                              │
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
   │   Worker 1   │   │   Worker 2   │ … │   Worker N   │  │
   │ exec-kit     │   │ exec-kit     │   │ exec-kit     │  │
   │ Playwright   │   │ Playwright   │   │ Playwright   │  │
   │ Test Runner  │   │ Test Runner  │   │ Test Runner  │  │
   │ + Chromium   │   │ + Chromium   │   │ + Chromium   │  │
   └──────────────┘   └──────────────┘   └──────────────┘  │
     （任意机器部署：出站可达 Server + 锁版本的 @playwright/test 与浏览器）│
```

要点：

- **Server 是唯一的中心**：持有数据库、用例仓库的读取权、调度权、产物汇聚与分发权。
- **Worker 完全被动**：只向 Server 发起出站 WebSocket 连接，等待任务下发；不需要访问用例仓库（用例以 Bundle 形式下发）、不需要监听任何端口、不需要共享磁盘。
- **cases/ 目录是唯一事实来源**：Server 与 cases 的 Git checkout 位于同一机器（或同一卷）；也支持通过配置指向任意外部仓库路径。

### 2.2 组件与职责

| 组件 | 进程形态 | 数量 | 职责 |
|------|---------|------|------|
| server | Node 常驻进程 | 1 | REST/WS API、用例扫描校验打包、批次调度（队列/租约/重试/恢复）、SQLite 读写、产物接收与静态服务、托管 Web UI 静态资源 |
| web | React SPA（构建产物） | - | 只读管理界面，由 server 托管 |
| worker | Node 常驻进程 | 1..N | 连接 Server、领任务、生成临时 config 后调起 playwright test runner 执行单个用例文件，经事件 reporter / CDP 侧车回传事件流，结束后上传产物 |
| mcp | 由 MCP 客户端按需拉起（stdio） | 0..N | 平台 REST API 的 MCP 封装（查询/执行/看结果） |
| cli（`tern`） | 本地命令行 | - | 供人、脚本、Agent 使用，与 MCP 共享同一 API client |
| cases/ | Git 管理的目录 | - | 用例唯一事实来源 |
| data/ | 本地目录 | - | SQLite、bundle 缓存、产物、临时文件 |

### 2.3 关键设计决策

| # | 决策 | 理由 | 放弃的备选 |
|---|------|------|-----------|
| D1 | **用例 = 原生 Playwright Test 脚本；Worker 用 playwright test runner 执行单个用例文件**（不自研的是「用例执行引擎」；Worker 执行管理层 exec-kit 仍是平台自研的必备组件）。平台通过四个不侵入语法的挂点获得控制力：**临时生成 config、自定义事件 reporter、CDP 画面侧车、墙钟进程看护**（v0.2 评审修改） | 脚本就是标准 `@playwright/test` 写法（`test()` / `expect` / fixture 原生全支持），对人和 Agent 零额外学习成本，IDE 提示、`playwright test` CLI 本地调试等生态全部可用；超时/重试/失败截图/trace/video 全部由 runner 原生配置获得，平台不重复造轮子。执行粒度 = 1 个平台用例（脚本文件）对应 1 次 runner 进程调用，与「Server 逐条调度」模型天然对齐 | 自研 harness + 库 API 驱动（v0.1 方案：控制力最强，但引入私有 CaseContext，偏离原生语法） |
| D2 | **用例在 Server 侧同步时用 esbuild 打包成自包含 Bundle 下发** | Worker 无需访问用例仓库、无需共享磁盘即可分布式部署；bundle 按 content-hash 缓存；用例的编译错误在同步期即暴露并报告（对 Agent 极友好——写完立刻知道能不能编译） | Worker 直读仓库（要求共享 FS 或各机 clone，运维重） |
| D3 | **Server↔Worker 用 WebSocket 长连接**（Worker 只出站） | 任务下发、事件回传（日志/画面帧）、取消、心跳复用一条连接；零消息队列依赖，部署简单 | REST 长轮询（实时性差）；引入 MQ（当前规模过重） |
| D4 | **远程实时画面用 CDP `Page.startScreencast`** | 「只读」是协议天然保证：screencast 只把浏览器渲染帧推给观察者，根本不存在输入回传通道；比 noVNC + 虚拟桌面方案轻量得多。代价：仅支持 Chromium（初期只默认 Chromium，可接受） | noVNC（重、且要额外防误操作）；录视频回放（不实时） |
| D5 | **SQLite（better-sqlite3，WAL 模式）单文件库** | 单 Server 进程下同步 API 简单可靠、无连接池问题；万级用例 + 十万级 run 的规模远超实际需要；备份 = 拷文件 | Postgres（部署重）；拆库（无必要） |
| D6 | **用例元数据 = 文件头部块注释中的 YAML frontmatter** | 单文件自描述，人与 Agent 都好读写，无需 sidecar 文件，git diff 友好 | 单独 manifest 清单文件（两处维护易漂移）；JSON 注解（注释里写 JSON 体验差） |

---

## 3. 技术选型

| 类别 | 选型 | 版本基线 | 理由 | 放弃的备选 |
|------|------|---------|------|-----------|
| 语言/运行时 | TypeScript / Node.js | TS 5.x / Node ≥ 20 LTS | 生态与 Agent 熟悉度最高 | - |
| 仓库形态 | pnpm workspace monorepo | pnpm 9 | 轻量、多包共享依赖 | turborepo/nx（当前规模不需要） |
| Web 框架 | Fastify + `@fastify/websocket` + `@fastify/static` | Fastify 5 | TS 一等公民、插件体系覆盖静态资源与 WS | Express（WS 集成更碎）、Hono |
| 数据库 | better-sqlite3（WAL） | 11.x | 同步 API、性能好、零运维 | Prisma/Drizzle（可后加，先手写 SQL migration 保持透明） |
| 浏览器自动化 | playwright（library API） | 1.4x，**全仓库锁同一版本** | tracing/screencast/CDP 支持完善 | puppeteer（生态弱） |
| 用例形态 | 标准 `@playwright/test` 写法（test / expect / fixture / testInfo 原生全支持） | 随 playwright | 原生语法零额外学习成本，IDE 与调试生态全可用 | 自研 CaseContext（v0.1 方案，已弃） |
| 前端 | React + Vite + Tailwind CSS | React 18 / Vite 5 | 管理端形态标准方案 | Vue / 服务端模板 |
| MCP | `@modelcontextprotocol/sdk`（TS） | 最新稳定 | 官方 SDK，stdio transport | 自实现协议 |
| 日志 | pino | 9.x | 结构化 JSON 日志 | - |
| 打包 | esbuild | 0.2x | 快、API 简单、TS 原生支持 | tsup（底层同 esbuild，多余封装） |
| ID | ULID（`ulid` 包） | - | 可排序、可读、URL 安全 | uuid4（不可排序） |
| 时间 | 全部 ISO 8601 UTC + 毫秒；时长一律毫秒整数 | - | Agent 解析无歧义 | - |

---

## 4. 用例库规范（一个 git 仓库 = 一个 project）

### 4.1 项目仓库布局

用例不维护在平台自己的仓库里。平台通过 `REPOS_DIR`（启动参数，默认 `./repos`，已进 .gitignore）管理若干**用例项目仓库**，一个仓库就是一个 project：

```
<repo>/
  tern.yaml               # ← 项目 meta（必需）：name / description / casesDir / auth / defaultTags
  package.json            # （可选）用例需要的额外 npm 依赖声明在这里（dependencies）
  _lib/                   # （可选）共享工具库（_ 前缀目录不视为用例），内容会打进 bundle
    login.ts
  cases/                  # 用例目录（默认 cases，可在 tern.yaml 用 casesDir 改）
    portal/
      login/
        login-basic.spec.ts
      order/
        order-create.spec.ts
```

**tern.yaml 字段表：**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `name` | string | ✔ | - | project 名称，全局唯一，kebab-case；也是 case id 的第一段 |
| `description` | string | | `''` | 项目说明（Web 项目页展示） |
| `casesDir` | string | | `cases` | 用例目录（相对仓库根） |
| `defaultTags` | string[] | | `[]` | 合并进本项目每个用例的 tags |
| `auth` | map | | `{}` | 登录方式声明（§4.6）：名字 → 配置；用例 frontmatter `auth: <名字>` 引用 |

项目接入方式（二选一）：

- **git 仓库**：Web「项目」页（或 `POST /api/v1/projects`、CLI `tern projects add <url>`、MCP `tern_add_project`）添加 git 地址 → 自动 `git clone --depth 1` → 读 `tern.yaml` 注册 → 首次同步。**认证**：默认 HTTP/HTTPS，账号密码可选（公开库可空）；SSH 必须提供私钥 PEM（写入临时 0600 文件 + `GIT_SSH_COMMAND -o IdentitiesOnly=yes -o IdentityAgent=none`，并清空 `SSH_AUTH_SOCK`——平台跑在容器内，**不会、也不能**使用宿主机 `~/.ssh`）。secret 落库但不回显。此后按 `pullIntervalSec`（默认 300s，页面可改，0=手动）**强制拉取**：`git fetch origin <branch> && git reset --hard FETCH_HEAD && git clean -fdx`——任何本地人工修改都会被清空，保证用例与远端一致；目录丢失自动重新 clone。
- **本地目录**：把含 `tern.yaml` 的目录直接放进 `REPOS_DIR`，server 启动与定期扫描时自动发现注册（`source=local`，不做 git 操作）；`fs.watch` 监听目录变化（防抖 2s）即改即同步。
- **项目改名**：`PATCH /api/v1/projects/:id { name }`（CLI `tern projects rename <id|name> <newName>`）——校验 kebab-case 与全局唯一（409）。**注册名是 caseId 第一段**：改名即换前缀，服务端自动重新同步（响应带 sync 结果），旧 caseId 软删除（`status=deleted`）成为历史；环境/测试集/定时/webhook 按 project_id 关联，不受影响；克隆目录随名字搬迁（避免重新 clone）。git 项目以注册名为准：仓库 `tern.yaml` 改了 `name` 而注册名没改时 sync 只告警不改名——两边对齐需显式 rename。

规则：

- 路径模式：`<casesDir>/<任意层级分组>/<case-name>.spec.ts`。
- **case id = `<项目名>/<相对 casesDir 的路径去掉扩展名>`**，如 `portal/login/login-basic`。路径即 ID：全局唯一、稳定、可预测（Agent 不需要查库就知道 ID）。
- 命名规范：目录与文件一律小写 kebab-case（`[a-z0-9-]`），同步时 lint 强制校验。
- `_` 前缀目录与 `.` 前缀目录 = 非用例（工具/fixture），不参与调度。

### 4.2 用例文件格式

元数据通过**文件头部指定格式的块注释**标注：YAML frontmatter，块注释首行必须是 `@tern` 标记行（用于与版权/说明注释明确区分，避免误识别）。正文就是**标准的 Playwright Test 脚本**——`test()` / `expect` / fixture 等原生写法全部可用，没有任何平台私有 API。

**frontmatter 字段表：**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `title` | string | ✔ | - | 用例标题（列表展示名） |
| `description` | string | | `''` | 用例说明 |
| `tags` | string[] | | `[]` | 自由标签：优先级（`smoke`/`p0`）、层次（`auth`/`regression`）等；与 version/module 组成多维筛选 |
| `version` | string | | - | **被测系统版本**（如 `v2.3` / `2024.1`），用于按版本筛选执行 |
| `module` | string | | - | **功能模块**（如 `login` / `order`），用于按模块筛选执行 |
| `auth` | string | | - | 引用项目 `tern.yaml` 中声明的 auth profile 名（登录方式，§4.6） |
| `timeout` | number（秒） | | 120（全局可配） | 单次执行墙钟超时 |
| `retries` | number | | 0 | 失败自动重试次数（批次可整体覆盖） |
| `disabled` | boolean | | false | `true`：标记为 disabled，不参与调度（如排查 flaky 时临时停用） |
| `author` | string | | - | 创建者（人名或 agent 名），便于追溯 |
| 其他任意字段 | any | | - | 原样存入 `meta` JSON，平台忽略（未来扩展如 `variants`） |

**完整示例：**

```ts
/**
 * @tern
 * title: 登录 - 正确账号密码登录成功
 * description: 使用测试账号登录 portal，验证跳转到工作台首页
 * tags: [smoke, login]
 * version: v2.3
 * module: login
 * auth: form-login          # 引用 tern.yaml 里的登录方式，执行前自动建立登录态
 * timeout: 90
 * retries: 1
 * author: agent
 */
import { test, expect } from '@playwright/test';
import { login } from '../../_lib/login';      // 仓库 _lib 共享工具，随 bundle 打包

test('正确账号密码登录后跳转工作台', async ({ page }) => {
  await page.goto('/');                        // 已带登录态（storageState）；baseURL 来自 BASE_URL
  await expect(page.getByText('工作台')).toBeVisible();
  console.log(`当前页面: ${page.url()}`);        // 日志：原生 console，实时回传
});
```

frontmatter 解析实现：取文件中**首个以 `@tern` 标记行开头的块注释**，逐行去掉前导 `*`，剩余文本按 YAML 解析（`yaml` 包）；找不到 `@tern` 块或解析失败 → 该用例标记 `invalid` 并入库报错原因，不阻塞其他用例。

粒度约定：**一个脚本文件 = 一条平台用例**。文件内可以写多个 `test()`（顺序执行：全部通过 → 用例通过；任一失败 → 用例失败，每个 `test()` 的明细保留在报告中）；建议一文件一个 `test()`，展示名写在 frontmatter `title`。

### 4.3 用例运行时约定（平台能力 → 原生写法映射）

平台的所有能力都映射到 Playwright 原生机制，用例内不出现任何平台私有 API：

| 平台能力 | 用例内的原生写法 |
|----------|-----------------|
| 页面 / 上下文 | `test('...', async ({ page }) => {...})`；`test.use()`、自定义 fixture 均可用 |
| 批次参数（如 BASE_URL、测试账号） | **环境变量注入**（runner 进程级）。生成的 config 会把 `BASE_URL` 映射为 `use.baseURL`，用例内直接 `page.goto('/login')`；其余参数用 `process.env.XXX ?? 默认值` 读取 |
| 日志 | `console.log / warn / error`（runner 捕获，平台实时回传 + 落盘）；结构化步骤用 `await test.step('步骤名', async () => {...})` |
| 断言 | `expect(...)`（原生 web-first 断言） |
| 超时 | frontmatter `timeout`（秒）→ 生成的 config `timeout`（毫秒），作用于文件内每个 `test()`；另有平台级墙钟上限兜底（§6.4） |
| 重试 | frontmatter `retries` → config `retries`（runner 内重试，重试后通过记为 flaky）；平台级重派见 §6.6 |
| 失败截图 / trace / video | config 原生配置（`screenshot: 'only-on-failure'`、`trace: 'retain-on-failure'` 等），用例完全不用关心 |
| 跳过 | 原生 `test.skip()` / `test.fixme()` → 平台记为 `skipped` |
| 自定义产物 | 原生 `testInfo.attach('name', { path / body })` 或 `testInfo.outputPath()`，平台统一收集上传（§8） |

### 4.4 用例编写约束（同步期 lint 强制）

1. frontmatter 必填 `title`；目录/文件名符合 kebab-case；tags 一律小写。
2. **import 白名单**：`playwright` / `playwright-core` / `@playwright/test` / Node 内置模块 / `cases/_lib` 与同仓库相对导入 / `cases/package.json` 中声明的依赖。白名单外的导入 → `invalid`。
3. 声明的依赖会被 esbuild 全量打包进 bundle；**含原生二进制（.node）的依赖在打包时报错**（提示改用环境变量 / HTTP 等方式获取能力）。
4. 用例必须**可独立执行**：用例之间不允许任何依赖或顺序假设（平台不保证执行顺序与所在 Worker）。
5. 禁止 import 平台内部模块（`apps/server`、`apps/worker`、`packages/*` 的任何代码）——用例只依赖 `@playwright/test`、`_lib` 与 `cases/package.json` 声明的依赖。
6. 用例不得依赖执行环境：不写死 Worker 主机路径、不假设执行顺序与所在机器；环境信息一律读注入的环境变量（批次参数 / `TERN_*`）。

lint / 打包失败的用例：`status = invalid`，错误信息（文件、行号、原因）入库，在 Web 同步报告、`GET /api/v1/sync`、MCP `tern_resync_cases` 返回中均可见。**这是 Agent 写用例的第一时间反馈回路。**

### 4.5 扫描与同步机制

触发时机（任一）：

- Server 启动时（发现本地项目 + git 项目拉取更新 + 全量重扫）；
- git 项目定期拉取到期（每 30s 检查，`pullIntervalSec` 到期即强制拉取）；
- `fs.watch` 监听 `REPOS_DIR`（防抖 2 秒，`SYNC_WATCH=false` 可关；平台自身 git 操作期间抑制，避免回环）；
- `POST /api/v1/sync`（全量）/ `POST /api/v1/projects/:id/sync`（单项目）（Web 按钮 / CLI / MCP / CI）。

同步流程（**按 project 串行执行**，git 操作与同步共用一个队列互斥）：

```
1. git 项目：fetch origin <branch> → reset --hard FETCH_HEAD → clean -fdx
   （目录缺失则重新 clone；本地项目跳过 git 步骤）
2. 重读 tern.yaml → 刷新项目 meta（description / casesDir / auth / defaultTags）
3. glob 扫描 <casesDir>/**/*.spec.ts（排除 _ 与 . 前缀目录）
4. 逐文件：读源码 → 解析 frontmatter → lint 校验（含 auth 引用检查）→ 计算 content_hash
5. 与库内对比（case id = <项目名>/<相对路径>）：
   - 新文件        → 插入 cases 记录 (status=active)
   - hash 变化     → 更新元数据，按新 hash 重新打包 bundle
   - 文件消失      → status=deleted（历史 run 保留；筛选默认排除）
   - lint/打包失败 → status=invalid，记录错误
   - frontmatter auth 引用的 profile 不存在 → invalid（AUTH_PROFILE_NOT_FOUND）
6. esbuild 打包：entry=用例文件, platform=node, format=cjs, bundle=true,
   external=['playwright','playwright-core','@playwright/test', node:*]
   产物写 data/bundles/<hash前2位>/<hash>.cjs（内容寻址缓存，永不重复打包）
7. 记录 sync_runs（project_id、新增/更新/删除/invalid 计数、git HEAD）
8. WS 广播 sync.completed + project.updated → Web 项目页/用例页自动刷新
```

Bundle 的意义（决策 D2）：执行时 Worker 通过 `GET /api/v1/bundles/<hash>.cjs` 拉取（本地按 hash 缓存），**完全不需要接触用例仓库**；同时把「用例能不能编译」从执行期提前到同步期。

### 4.6 登录方式（auth profiles）

> **本节已被 [auth-design.md](./auth-design.md)（已实现）替换**：配置拍平（不再套 `form:`/`api:`/`storage:` 子对象）、支持听鉴 `GET /api/auth/loginMock?clientId=` 后门登录、创建 run 时从仓库现读 auth 配置并快照、`accounts` 账号表 + `AUTH_ACCOUNT` 运行期覆盖、`auth: none`、会话按 worker 复用 + `validate` 失效重登。旧嵌套形态读取时自动归一（兼容层）。以下为旧版行为描述，仅作历史参考。

被测系统需要登录时，登录流程**不写进用例**——在项目 `tern.yaml` 的 `auth` 里声明为一个 profile，用例 frontmatter 用 `auth: <名字>` 引用；Worker 在执行用例前先按 profile 建立**playwright storageState**（cookie + localStorage），生成的临时 config 以 `use.storageState` 注入，用例内的 `page` 天然带登录态。

三种内置方式（可并存多个 profile，按用例各自引用）：

```yaml
auth:
  # 1) 表单登录：无头浏览器真实走一遍登录页
  form-login:
    mode: form
    form:
      loginUrl: /login                 # 相对路径拼接批次参数 BASE_URL
      userSelector: '#username'
      passSelector: '#password'
      submitSelector: 'button[type=submit]'
      successUrl: '/'                  # 可选：等待跳转判定登录成功
      username: ${ENV:PORTAL_USER}
      password: ${ENV:PORTAL_PASS}

  # 2) 接口登录：直接调登录 API
  api-login:
    mode: api
    api:
      url: /api/login
      method: POST
      body: { username: ${ENV:PORTAL_USER}, password: ${ENV:PORTAL_PASS} }
      save:                            # 可选：响应字段写入 localStorage
        - { origin: ${ENV:BASE_URL}, key: token, from: data.token }
      # 响应 Set-Cookie 自动并入登录态，无需配置

  # 3) 直写 storage：直接注入 cookie / localStorage（长期 token、第三方签发会话）
  storage-login:
    mode: storage
    storage:
      cookies:
        - { name: session, value: ${ENV:PORTAL_SESSION}, domain: ${ENV:TARGET_HOST}, path: / }
      localStorage:
        - { origin: https://portal.example.com, key: token, value: ${ENV:PORTAL_TOKEN} }
```

凭据安全：所有 auth 配置中的字符串支持 `${ENV:VAR}` 占位符，**在 Worker 端解析**（来源 = worker 环境变量 + 批次参数注入），凭据既不进 git 仓库、也不落 server 数据库；占位符变量缺失 → 该 run 以 `AuthError` 失败，错误信息含变量名。API 地址/选择器类配置也支持占位符（如 `${ENV:BASE_URL}`），便于多环境复用同一仓库。

---

## 5. 数据模型

### 5.1 ER 概览

```
projects 1───N cases 1───N case_tags（tag 多对多）
batches  1───N batch_items N───1 cases
batch_items 1───N case_runs N───1 workers
sync_runs / events（审计与事件回放，独立）
```

### 5.2 表结构

**projects**（项目注册表，随扫描自动 upsert）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| name | TEXT UNIQUE | = 一级目录名（kebab-case） |
| description | TEXT | （预留，暂来自 README 或空） |
| created_at | TEXT ISO | |

**cases**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 路径派生 ID，如 `portal/login/login-basic` |
| project_id | INTEGER FK | |
| title | TEXT | |
| description | TEXT | |
| file_path | TEXT | 相对 CASES_DIR 的路径 |
| source | TEXT | 最近一次同步时的源码快照（供 API/MCP 免 FS 读取） |
| timeout_s | INT | |
| retries | INT | |
| meta | TEXT(JSON) | frontmatter 扩展字段 |
| content_hash | TEXT | 源码 sha256 |
| bundle_hash | TEXT | bundle 内容寻址 hash |
| status | TEXT | `active` / `deleted` / `invalid` / `disabled` |
| last_error | TEXT | invalid 时的 lint/编译错误 |
| created_at / updated_at | TEXT ISO | |

**case_tags**

| 字段 | 类型 | 说明 |
|------|------|------|
| case_id | TEXT | 联合主键 |
| tag | TEXT | 联合主键；索引 (tag) |

**sync_runs**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| started_at / finished_at | TEXT ISO | |
| added / updated / removed / invalid | INT | 计数 |
| git_commit | TEXT nullable | |
| error | TEXT | 同步整体失败时的原因 |

**batches**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | ULID，`b_` 前缀 |
| title | TEXT | |
| created_by | TEXT | `web` / `mcp` / `cli` / `api` |
| scope | TEXT(JSON) | 创建时的筛选条件快照（审计） |
| params | TEXT(JSON) | 批次参数 |
| max_attempts | INT | 每条用例最大尝试次数（默认 = 用例 retries + 1） |
| status | TEXT | `pending` / `running` / `completed` / `cancelled` |
| total / passed / failed / timed_out / error / skipped / cancelled | INT | 统计列（终态时落定） |
| git_commit | TEXT | 创建批次时用例库的 commit |
| created_at / started_at / finished_at | TEXT ISO | |

**batch_items**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | `i_` 前缀 |
| batch_id | TEXT FK | 索引 (batch_id, status) |
| case_id | TEXT FK | |
| position | INT | 批次内顺序 |
| status | TEXT | 状态机见 §5.3 |
| attempt | INT | 当前尝试序号（从 1 起） |
| max_attempts | INT | 冗余存储快照 |
| claimed_worker_id | TEXT nullable | |
| lease_until | TEXT ISO | 认领租约（防下发丢失） |
| final_run_id | TEXT nullable | 最终生效的 run |
| started_at / finished_at / duration_ms | | 终态时落定 |
| last_error | TEXT | 最近一次错误摘要 |

**case_runs**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | `r_` 前缀 ULID |
| batch_item_id / batch_id / case_id | TEXT FK | |
| worker_id | TEXT | |
| attempt | INT | |
| run_token | TEXT | 随机令牌：**所有结果上报必须携带且匹配才被接受**，防止过期/重派后的旧报文污染状态 |
| status | TEXT | `running` / `passed` / `failed` / `timed_out` / `error` / `skipped` / `cancelled` / `lost` |
| flaky | INT (0/1) | runner 内重试后通过（Playwright 语义的 flaky）时置 1，状态仍为 `passed` |
| started_at / finished_at / duration_ms | | |
| error | TEXT(JSON) | `{ name, message, stack }` |
| artifacts | TEXT(JSON) | `{ trace?, screenshots?: string[], videos?: string[], attachments?: string[], log?, missing?: string[] }` |
| bundle_hash | TEXT | 执行的 bundle 版本 |

**workers**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | `w_` 前缀（重连复用） |
| name | TEXT UNIQUE | 默认 hostname，可配置 |
| hostname / ip | TEXT | |
| agent_version | TEXT | 平台版本 |
| playwright_version | TEXT | **与 Server 锁定版本比对，不匹配则拒绝接入并提示** |
| capabilities | TEXT(JSON) | `{ browsers: ['chromium'], maxSlots: 1 }` |
| status | TEXT | `online`(空闲) / `busy` / `offline` |
| current_run_id | TEXT nullable | |
| last_heartbeat_at / registered_at | TEXT ISO | |
| stats | TEXT(JSON) | 累计执行/通过/失败数 |

**events**（仅状态变更类事件持久化；日志与画面帧不落库）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| ts | TEXT ISO | |
| topic | TEXT | `batch:<id>` / `workers` / `system` |
| type | TEXT | `batch.updated` / `item.updated` / `worker.updated` / `alert` 等 |
| payload | TEXT(JSON) | |

### 5.3 状态机

**batch_item：**

```
                 assign(租约60s)              accept
  pending ───────────────────▶ claimed ──────────────▶ running ──┬──▶ passed
     ▲  │                        │                          │    ├──▶ failed ──(attempt<max)──▶ 回 pending
     │  │                        │ lease到期 / reject        │    ├──▶ timed_out ─(attempt<max)─▶ 回 pending
     │  │                        └────────▶ pending          │    ├──▶ error
     │  │                                                   │    ├──▶ skipped（用例内 test.skip()）
     │  │                                                   │    ├──▶ cancelled   ←─ (收到 cancel 命令)
     │  └──────────────── cancel ───────────────────────────┘    └──▶ (worker失联超宽限: attempt<max? 回pending : failed[lost])
     └─────────────────── 调度器重新入队 ◀────────────────────────────┘
```

**batch：** `pending → running → completed | cancelled`（cancelled 可从任意状态进入；强制取消不等 Worker 回执，靠 run_token 拒绝迟到报文）。是否「通过」由统计列表达（failed/timed_out/error > 0 即视为有失败），不设独立 failed 终态。

**worker：** `offline → online(idle) ⇄ busy → offline`（心跳超时 30s 或主动下线）。

### 5.4 数据库迁移机制（随版本自动升级）

SQLite schema 由 `apps/server/src/migrations.ts` 中有序的 `MIGRATIONS` 数组定义（id 单调递增、SQL 内嵌、无外部文件依赖）。**server 每次启动 `openDb()` 自动补齐未应用的迁移**，升级容器/代码即自动完成 DDL 升级，无需人工干预：

- 版本记录在 `_migrations` 表（id、name、applied_at、duration_ms；对仅有 id/applied_at 两列的旧结构记录表自动 ALTER 兼容）；
- 每个迁移在**单独事务**内执行：DDL 与迁移记录同生共死，失败整体回滚，不留半成品 schema，启动报错并带迁移名；
- 表重建类迁移（SQLite 不能改列/删列）标记 `needsFkOff`：按 SQLite 官方流程先 `PRAGMA foreign_keys=OFF`，执行后 `foreign_key_check` 兜底校验；
- `node apps/server/dist/migrate-cli.js status|up`：运维/CI 可独立查看版本与待应用迁移、显式执行（与启动自动迁移同一代码路径）。

写新迁移的约定：只增不改——已发布的迁移 SQL 不可修改，新变更追加 `id` 更大的新迁移；增量优先 `ALTER TABLE ADD COLUMN`，确需重建表时新表建好后数据搬迁再 `DROP + RENAME` 并标记 `needsFkOff`。迁移正确性由 `apps/server/src/migrations.test.ts` 覆盖（全新建库、旧版升级数据保留、旧记录表兼容、失败回滚）。

---

## 6. 执行模型

### 6.1 测试运行创建（选择用例）

创建入口：Web 对话框 / `POST /api/v1/runs` / MCP `tern_run_cases` / CLI `tern run`。

一次测试运行**只归属一个 project**（必填；仅传 `caseIds` 时可从用例推导，但必须同属一个项目），可覆盖该项目的**多个 version / module / tag**。`workerId` 缺省则所有空闲 worker 并行领取；指定则只派给该 worker。

创建即解析筛选条件并**快照**成 batch_items（之后用例文件变更不影响本次运行的构成）：

```
筛选条件（可组合）:
  project    项目名（必填，除非只传同项目 caseIds）
  version    被测系统版本（可多选）
  module     功能模块（可多选）
  tags       标签列表 + tagMode: 'any'(默认, 任一命中) | 'all'(全部命中)
  excludeTags 排除标签
  caseIds    显式 ID 列表（与筛选条件取并集；MCP/CLI 常用）
  q          标题/描述/ID 关键字（仅 Web）
解析 → 仅 status=active 的用例可入选 → 创建 run + 按顺序写 items(pending)
空结果 → 400 错误，明确告知筛选命中 0 条（Agent 立即可感知写错了筛选）
跨项目 → 400 MULTIPLE_PROJECTS / PROJECT_REQUIRED
```

示例请求/响应：

```json
POST /api/v1/runs
{
  "title": "portal 冒烟",
  "project": "portal",
  "version": ["v2", "v2.1"],
  "tags": ["smoke"], "tagMode": "any",
  "excludeTags": ["flaky"],
  "params": { "BASE_URL": "https://staging.example.com" },
  "maxAttempts": 2
}
→ 200
{ "run": { "id": "b_01J8ZT3K...", "status": "pending", "total": 23, "project": "portal", "createdBy": "mcp" } }
```

执行选项（写入生成的 runner config）：`trace`: `'retain-on-failure'`（默认）/ `'on'` / `'off'`；`video`: `false`（默认）/ `true`。

### 6.2 调度（队列、认领、租约、防错报）

- 全局**单队列 FIFO**：`batch_items WHERE status='pending' ORDER BY batch.created_at, position`。单 Server 进程内用 better-sqlite3 事务完成「取出→置 claimed→写租约」，天然无并发竞态（无需分布式锁）。
- Worker 有空闲槽位（初始 `maxSlots=1`，协议预留多槽）时 Server 推送 `assign`；Worker 回 `accept`（→ running）或 `reject`（如浏览器未就绪 → 立即回队列改派他人）。
- **租约**：`assign` 后 60s 内未收到 `accept` → 视为下发丢失，自动 requeue。
- **run_token**：每次 assign 生成随机 token；此后该 run 的所有上报（事件/结果）必须携带匹配 token。重派或强制取消后，旧 Worker 的迟到报文因 token 不匹配被拒绝（记为 stale 事件供排查），从根上消除「幽灵结果」。

### 6.3 Worker 生命周期

```
启动 → 读取配置(SERVER_URL, WORKER_TOKEN) → 出站 WS 连接 /ws/worker
     → hello{name, version, playwright_version, capabilities}
       ├─ Server 校验 token、playwright 版本 → hello_ack{workerId, heartbeatIntervalMs}
       ├─ 版本不匹配 → 拒绝接入并返回明确错误（Agent 可据此修环境）
     → 周期 heartbeat(10s){status, currentRunId}
     → 空闲时等待 assign（被动）
     → 执行中持续回传 run_event；结束后回传 result + 上传产物
     → 断线：本地继续执行当前用例并缓存事件 → 指数退避重连
        → 重连成功：hello 带 lastRunId，Server 校验 run_token 后 re-attach，缓存事件补发
        → 超过宽限(60s)未重连：按崩溃处理（§6.5 #4）
     → 优雅退出：SIGTERM → 通知 server draining → 当前用例跑完/中止 → close
```

Server 判定离线：3 个心跳周期（30s）无心跳 → `offline`。

### 6.4 单用例执行时序（Worker 执行管理层 exec-kit）

accept(task) 后，Worker 父进程在本地组装**一次独立的 runner 进程调用**（1 个平台用例 = 1 次 `playwright test`）：

```
 1. 按 bundle_hash 取本地缓存，否则 GET /api/v1/bundles/<hash>.cjs 下载并校验
 2. 组装运行目录 tmp/<runId>/：
      case.spec.js          # bundle（自包含，仅外部依赖 @playwright/test 与 node 内置）
      playwright.config.js  # 平台按模板生成（见下）
 3. 从本机端口区间分配一个 CDP 端口（仅监听 127.0.0.1），写入 config launchOptions
 4. 以子进程调起 runner：
      npx playwright test case.spec.js --config=playwright.config.js
    环境注入：批次参数（BASE_URL 等）+ TERN_RUN_ID / TERN_BATCH_ID / TERN_CASE_ID
 5. 【事件 reporter】exec-kit 提供的自定义 reporter 经 config 挂载，把 runner 事件
    （onTestBegin / onTestEnd / onStepBegin|End / onStdOut|Err / onError / onEnd）
    以 NDJSON 回传父进程（POST http://127.0.0.1:<随机端口>/event）
    → 父进程转成平台 run_event 经 WS 上行（实时进度/日志/步骤由此而来）
 6. 【CDP 侧车】父进程连 http://127.0.0.1:<cdpPort>/json 找到 page target；
    仅当 Server 通知「有观战者」时 Page.startScreencast 并转发帧（§7.3）
 7. 【墙钟看护】父进程对子进程计时（CASE_HARD_TIMEOUT_S，默认 600s），
    超时 SIGKILL 整个进程组 → run 置 timed_out
 8. 子进程退出：解析 reporter onEnd 结果 → 平台状态映射：
      全部 passed              → passed
      存在 flaky（重试后通过）  → passed（flaky=1）
      存在 failed              → failed
      全部 skipped 且无失败    → skipped
      进程崩溃 / 无结果        → error
 9. 收集 runner 输出目录（test-results/）：trace、失败截图、video、attachments
    → 汇总 result → WS 上报（runId + runToken）
10. POST /api/v1/runs/:runId/artifacts 上传产物（§8.3）
11. 清理 tmp → slot 空闲 → 等待下一个 assign
```

生成的 `playwright.config.js` 要点：

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', workers: 1, fullyParallel: false,     // 单文件内顺序执行，与平台粒度一致
  timeout: <frontmatter.timeout * 1000>,              // 用例级超时
  retries: <frontmatter.retries>,                     // runner 内重试（flaky 语义）
  reporter: [['<exec-kit reporter 绝对路径>']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.BASE_URL,                    // 批次参数映射
    screenshot: 'only-on-failure',                    // 失败自动截图（原生）
    trace: <批次选项>,                                 // retain-on-failure | on | off
    video: <批次选项>,                                 // off | on
    launchOptions: { args: ['--remote-debugging-port=<cdpPort>'] },
  },
});
```

平台对执行的全部控制力来自这四个挂点（**config 生成、事件 reporter、CDP 侧车、进程看护**），完全不侵入用例语法——这就是「不自研 harness」与「平台可控」的兼容点。

### 6.5 异常处理矩阵

| # | 异常场景 | 检测机制 | 处理 |
|---|---------|---------|------|
| 1 | 断言失败 / 用例抛错 | runner reporter `onTestEnd` | runner 自动截图 + trace + 日志 → `failed`；attempt < max → 重入队 |
| 2 | 用例超时 | runner 用例级 `timeout` + 平台墙钟看护（§6.4） | `timed_out`；计入重试 |
| 3 | runner 进程崩溃 / 浏览器崩溃 | 子进程异常退出且无 onEnd 结果 | 该 run `error(crash)`；下次调用是全新进程，天然自愈 |
| 4 | Worker 进程崩溃 / 断电 | 心跳丢失 30s + 宽限 60s | 其 running item：attempt < max → requeue；否则 `failed[lost]`；worker 置 offline |
| 5 | WS 网络抖动断连 | 连接层 | Worker 本地继续执行并缓存事件；重连后 re-attach 补发；超宽限按 #4 |
| 6 | 任务下发丢失 | 租约 60s 到期未 accept | requeue 改派其他 Worker |
| 7 | Server 重启 | 启动恢复流程（§6.7） | — |
| 8 | 产物上传失败 | 上传超时/校验失败 | 结果仍生效；artifacts 标记 missing + 告警事件；Worker 本地保留 24h 支持 `tern worker reupload` 补传 |
| 9 | 同步期编译/lint 失败 | esbuild/lint 报错 | case 置 `invalid` + 错误详情；不阻塞其他用例 |
| 10 | Server 磁盘写满 | 产物落盘异常 | run 置 `error(disk)`；发 system alert 事件（Web 顶部横幅） |

### 6.6 取消与重试

- **取消批次**：pending 项立即置 `cancelled`；claimed 项置 `cancelled`；running 项向对应 Worker 发 `cancel`，Worker 终止 runner 子进程（SIGKILL 进程组，尽量保留已生成产物）并回传 `cancelled`。两种模式：
  - **软取消**（`force=false`）：只向已进入 running 的条目发中断；claimed 未 accept / pre-run（下载·登录）中的条目标记取消后等自然收敛，其迟到结果被拒。
  - **强制结束**（`force=true`，CLI/MCP 默认、Web「强制结束」按钮）：本地立即置 `cancelled` 不等回执；**无论条目处于哪个阶段**（claimed 未 accept、pre-run/登录中、running）一律向 worker 发中断；worker 不在线（或发送失败）时报文入 `pendingCancels` 补发队列，等它下次 hello（含断线重连）时补发——避免掉线 worker 重连后把已取消的用例继续跑完。迟到结果/事件不回写终态（`handleResult` 见 case_runs 非 running 即拒，防幽灵结果翻案），但迟到前上传的产物照收入库。
- **两层重试，职责不同**：
  - **runner 内重试（原生）**：frontmatter `retries` → config `retries`，同一进程内快速重试，适合抖动型失败；重试后通过以 flaky 记录（passed + flaky 标记），天然提供 flaky 统计口径。
  - **平台级重派**：run 终态为 `failed` / `timed_out` / `error` / `lost` 且 attempt < maxAttempts 时重新入队（产生新 run，可派到其他 Worker），直到 `maxAttempts`（默认 = 用例 retries + 1，批次可覆盖）。`passed` / `cancelled` / `skipped` 不重派。
- **手动重跑失败**：`POST /api/v1/runs/:id/retry-failed`（及 MCP/CLI 同名能力）→ 基于原批次中终态为失败的 case 集合创建**新批次**（保留血缘字段引用原批次），便于 Agent「修复后验证」闭环。
- **手动全量重跑**：`POST /api/v1/runs/:id/rerun` → 基于原批次**全部 case** 创建新批次，沿用源运行的环境 / 参数（secret 密文透传）/ 指定 worker / trace·video 选项；源批次仍在进行中时报 409。Web 在运行详情页与运行列表行内提供「重跑」「重跑失败」按钮。

### 6.7 Server 重启恢复

```
启动时:
 1. workers 全部置 offline（等待重连）
 2. batch_items: claimed（未被 accept）→ 全部 requeue
 3. running 项：保留，等 Worker 重连上报；超过 lease + 宽限仍无主 → requeue 或 failed[lost]
 4. 重算受影响 batch 的状态与统计
 5. 恢复完成前 /api/v1/meta 返回 starting 状态（健康检查可感知）
```

---

## 7. 实时能力

### 7.1 WS 协议总览

两个通道，消息均为 JSON：

- **`/ws/worker`**：Worker 专用，Bearer WORKER_TOKEN（见 §9.2 上半部分消息表）。
- **`/ws/app`**：Web 页面 / CLI `--watch` / 未来第三方集成使用，基于「订阅-推送」：

```
客户端 → 服务端:  { "type":"subscribe",   "topics":["batch:b_xxx","run:r_yyy","workers","batches"] }
客户端 → 服务端:  { "type":"unsubscribe", "topics":[...] }
服务端 → 客户端:  { "type":"event", "topic":"batch:b_xxx", "event":{ "type":"item.updated", "payload":{...} } }
```

事件类型：`batch.updated`、`item.updated`、`run.started`、`run.log`、`run.frame`、`run.finished`、`worker.updated`、`sync.completed`、`system.alert`。断线重连后客户端以 `events?id=<lastEventId>` 补播（events 表的持久化事件，日志/帧不补播，仅补状态）。

### 7.2 实时进度

- 每次 batch_item 状态变更 → 广播 `item.updated`（含状态、耗时、错误摘要）+ 聚合后的 `batch.updated`（统计列）。
- 批次详情页进度条 = 终态 item 数 / total；行级状态图标实时跳变，无需轮询。

### 7.3 远程浏览器实时画面（只读）

- 采集：决策 D4。runner 启动浏览器时即携带 `--remote-debugging-port=<本机端口>`（仅监听 127.0.0.1，常开成本可忽略）；Worker 父进程的 CDP 侧车在收到「有观战者」通知后连接该端口，对 page target 执行 `Page.startScreencast`（jpeg, quality≈50, maxWidth 1280，节流 ≤5fps 并立即 ack 保证帧流动）。
- 链路：Worker `run_event{type:'frame', data(base64)}` → Server 扇出给订阅 `run:<id>` 的客户端（Worker→Server 链路不因观战人数增加而放大）。
- Server 为每个活跃 run 缓存**最新一帧**：新观战者打开瞬间即可看到画面，无需等待下一帧。
- **按需采集**：某 run 观战人数从 0 → 1 时 Server 通知 Worker 开 screencast，归零时停止——无人观看时零开销。
- **只读保证**：协议上只有浏览器→观察者的帧推送，不存在任何输入回传通道；前端仅渲染 `<img>`。
- 前端：批次详情页 running 行显示「📺 实时画面」按钮 → 弹窗订阅帧 + 显示帧率/延迟指示；关闭即退订。
- 限制：仅 Chromium 支持实时画面（Firefox/WebKit 用例可执行、可回放 trace，但无实时画面）。

### 7.4 实时日志

- 用例内的 `console.log/warn/error`、页面 console、runner 捕获的 stdout/stderr → 事件 reporter → `run_event{type:'log'}` 实时广播；`test.step()` 步骤以 `run_event{type:'step'}` 回传，批次详情页可展示步骤时间线。
- Server 同时把日志行追加落盘到 `data/artifacts/<batchId>/<runId>/run.log`（终态后即是完整日志文件，观战与否都不丢）。

---

## 8. 产物与文件存储规范

### 8.1 目录布局

所有运行时文件集中在 `data/`（gitignore），**按批次 → run 两级组织**：

```
data/
  platform.db                       # SQLite（含 WAL 文件）
  bundles/                          # 用例 bundle 内容寻址缓存
    ab/ab34ef....cjs
  artifacts/
    <batchId>/                      # 例 b_01J8ZT3K...
      <runId>/                      # 每次执行一个目录（重试各自独立）
        trace.zip                   # Playwright trace（可完整回放；retain-on-failure 时仅失败用例有）
        screenshots/                # runner 原生失败截图（每个失败的 test() 一张）
        videos/                     # 执行视频（批次开启 video 时，每个 test() 一段）
        attachments/                # 用例 testInfo.attach() 的自定义产物
        run.log                     # 全量日志（Server 实时落盘）
        events.jsonl                # reporter 事件流水（结构化）
      batch-report.json             # 批次终态汇总（含每条结果与产物清单）
  tmp/                              # Worker 侧临时目录（运行时）
```

### 8.2 产物说明

| 产物 | 生成时机 | 用途 |
|------|---------|------|
| trace.zip | runner 原生（`retain-on-failure` 时仅失败有；批次选 `on` 时全量） | Playwright trace viewer 完整回放：DOM 快照、网络、console、操作步骤 |
| screenshots/*.png | runner 原生失败截图（`screenshot: 'only-on-failure'`），每个失败的 `test()` 一张 | Web/MCP 中直接查看失败现场（Agent 可通过 MCP image content 直接「看」） |
| videos/*.webm | 批次开启 `video` 时 | 人工回看（默认关闭，控制体积） |
| attachments/* | 用例内 `testInfo.attach()` | 用例自定义数据（JSON/文件等） |
| run.log | Server 实时追加（源自 reporter 捕获的 stdout/stderr） | 全量日志 |
| events.jsonl | run 终态写入 | reporter 事件流水（结构化），供脚本分析 |
| batch-report.json | 批次终态 | 一次性导出整批结果，CI 友好 |

### 8.3 产物汇聚协议（Worker → Server）

- Worker 执行结束后 `POST /api/v1/runs/:runId/artifacts`（multipart，Bearer WORKER_TOKEN，`X-Run-Token` 校验）。
- Server 落盘到对应 run 目录；文件名白名单校验（防路径穿越）；单 run 上传上限默认 100MB（video 计入）。
- 可选 `ARTIFACT_MODE=shared`：Worker 与 Server 共享磁盘时直接写路径、跳过上传（同机部署优化）。

### 8.4 保留策略

- 每日清理任务：终态超过 `ARTIFACT_RETENTION_DAYS`（默认 14 天）的批次删除产物目录；DB 记录保留（artifacts 字段标记 purged）。
- `data/bundles/` 按 hash 引用计数清理（无 active case 引用时删除）。

---

## 9. API 设计

约定：全部 JSON；时间 ISO 8601 UTC；错误统一 `{ "error": { "code": "CASE_NOT_FOUND", "message": "...", "details": {} } }`；列表接口支持 `limit`（默认 **20**）/ `offset`，返回 `{ items, total, limit, offset }`。

### 9.1 REST 端点

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/v1/meta` | 版本、casesDir、最近 sync、git commit、运行统计、健康状态 |
| GET | `/api/v1/projects` | 项目列表（含用例计数） |
| GET | `/api/v1/cases` | `?project=&tags=a,b&tagMode=all\|any&excludeTags=&q=&status=&limit=&offset=` |
| GET | `/api/v1/cases/:caseId` | 元数据 + 源码 + bundle_hash + 最近 10 次执行 |
| GET | `/api/v1/tags` | 标签及用例计数（供筛选器） |
| POST | `/api/v1/sync` | 触发同步（`?async=true` 立即返回 jobId） |
| GET | `/api/v1/sync` | 最近同步记录（含 invalid 用例错误明细） |
| POST | `/api/v1/runs` | 创建并开始测试运行（§6.1） |
| GET | `/api/v1/runs` | `?status=&project=&createdBy=&workerId=&q=&createdFrom=&createdTo=&limit=&offset=`（默认 limit=20） |
| GET | `/api/v1/runs/:id` | 测试运行详情 + items（可 `?itemStatus=failed` 过滤） |
| POST | `/api/v1/runs/:id/cancel` | 取消（`?force=true` 强制） |
| POST | `/api/v1/runs/:id/retry-failed` | 失败用例生成新运行（返回新 run） |
| POST | `/api/v1/runs/:id/rerun` | 全部用例生成新运行（沿用环境/参数/worker/选项；进行中 409） |
| GET | `/api/v1/executions/:id` | 单用例执行详情：错误、日志尾 200 行、产物清单与 URL |
| GET | `/api/v1/executions/:id/logs` | 全量日志 |
| GET | `/api/v1/workers` | Worker 列表与状态 |
| GET | `/api/v1/bundles/:hash.cjs` | Worker 拉取用例 bundle（token） |
| POST | `/api/v1/executions/:id/artifacts` | Worker 上传产物（multipart + token） |
| GET | `/artifacts/*` | 产物静态服务（`Access-Control-Allow-Origin: *`，供 trace viewer 加载） |

### 9.2 WS 协议（Worker 通道）

| 方向 | type | payload 要点 | 说明 |
|------|------|-------------|------|
| W→S | `hello` | `{name, version, playwrightVersion, capabilities, lastRunId?}` | 注册/重连 |
| S→W | `hello_ack` / `hello_reject` | `{workerId, heartbeatIntervalMs}` / `{reason}` | |
| W→S | `heartbeat` | `{status:'idle'\|'busy', currentRunId?}` | 默认 10s |
| S→W | `assign` | 见下方示例 | 仅推给空闲槽位 |
| W→S | `accept` / `reject` | `{runId, runToken, reason?}` | reject → 任务立即回队列 |
| W→S | `run_event` | `{runId, runToken, event:{type:'started'\|'log'\|'step'\|'frame', …}}` | 事件流（源自 runner reporter；含画面帧） |
| W→S | `result` | `{runId, runToken, status, durationMs, error?, artifacts?}` | 单次执行终态 |
| S→W | `cancel` | `{runId}` | 中止当前用例 |
| S→W | `screencast_on` / `screencast_off` | `{runId}` | 观战人数 0↔1 切换采集 |

`assign` 示例：

```json
{
  "type": "assign",
  "run": {
    "runId": "r_01J8ZT9A...",
    "runToken": "8f3c1a...",
    "batchId": "b_01J8ZT3K...",
    "batchItemId": "i_01J8ZT5C...",
    "case": {
      "caseId": "portal/login/login-basic",
      "title": "登录 - 正确账号密码登录成功",
      "bundleHash": "ab34ef...",
      "bundleUrl": "/api/v1/bundles/ab34ef....cjs",
      "timeoutS": 90,
      "attempt": 1,
      "maxAttempts": 2
    },
    "params": { "BASE_URL": "https://staging.example.com" },
    "options": { "trace": "retain-on-failure", "video": false }
  }
}
```

### 9.3 认证

- Worker：`WORKER_TOKEN`（Server 首次启动若无配置则自动生成并打印一次，存 `data/.worker-token` 备查）。
- 写操作（创建批次/取消/同步）：默认内网开放；配置 `API_TOKEN` 后需 `Authorization: Bearer`。读操作始终开放。
- `/ws/app` 做 Origin 校验（同源或配置白名单）。

---

## 10. MCP 设计

### 10.1 部署形态

MCP Server 是**平台 REST API 的瘦封装**（不碰 DB、不碰文件系统），以 stdio transport 由 MCP 客户端按需拉起，环境变量指向平台地址：

```json
{
  "mcpServers": {
    "tern": {
      "command": "npx",
      "args": ["-y", "Tern-mcp"],
      "env": { "TERN_URL": "http://10.0.0.5:7430", "TERN_TOKEN": "..." }
    }
  }
}
```

好处：MCP 与平台解耦部署，任何机器上的 Agent（ZCode / Claude / Cursor 等）接入只需一个 URL。

### 10.2 Tools

| 工具 | 入参 | 出参 | 说明 |
|------|------|------|------|
| `tern_list_projects` | - | 项目 + 用例数 + 最近同步 + 认证摘要 | |
| `tern_add_project` | `gitUrl`, `credentialType?`, `username?`, `secret?` | 项目 + 首次同步 | HTTP 账号密码或 SSH 私钥 |
| `tern_list_cases` | `project?`, `version?`, `module?`, `tags?`, `tagMode?`, `excludeTags?`, `q?`, `limit?`, `offset?` | 用例摘要数组（默认 20 条） | Agent 找用例的主入口 |
| `tern_get_case` | `caseId` | 元数据 + **完整源码** | |
| `tern_run_cases` | `project?` + `version?`/`tags?` 或 `caseIds?`，`workerId?`, `wait?` | runId + （wait=true 时）最终统计 | 一次运行一个 project；wait 语义 |
| `tern_list_runs` | `status?`, `project?`, `createdBy?`, `workerId?`, `q?`, `limit?` | 测试运行列表（默认 20 条） | |
| `tern_get_run` / `tern_wait_run` / `tern_cancel_run` | `runId` | 测试运行详情 | |
| `tern_retry_failed` | `runId`, `wait?` | 新 runId + 统计 | 修复后验证的标准动作 |
| `tern_rerun` | `runId`, `wait?` | 新 runId + 统计 | 全量重跑（沿用源运行配置） |
| `tern_get_execution` | `executionId` | 错误详情 + 日志尾部 + 产物清单 | |
| `tern_get_screenshot` | `executionId` | **MCP image content**（失败截图二进制） | 多模态 Agent 可直接「看」失败现场 |
| `tern_list_workers` | - | Worker 状态 | |
| `tern_resync_cases` | - | 同步统计（含 invalid 错误明细） | 写完用例后第一时间校验 |

### 10.3 Resources 与 Prompts

- Resources：`tern://case-spec`（用例编写规范全文）、`tern://batches/latest/report`（最近批次报告）。
- Prompts：`tern_write_case_guide`（返回「如何写一个用例」的规范要点 + 模板），Agent 可自取。

### 10.4 典型 Agent 工作流

```
1. tern_list_cases(project="portal", q="登录")      # 或读 AGENTS.md / tern://case-spec
2. 写 cases/portal/login/login-basic.spec.ts        # 直接改代码库（可先 tern new case 生成模板）
3. tern_resync_cases()                               # 确认无 lint/编译错误
4. tern_run_cases(tags=["smoke"], project="portal", wait=true, timeoutS=600)
5. 失败 → tern_get_run / tern_get_screenshot          # 看错误与失败画面
6. 修用例或给产品提 bug → commit → tern_retry_failed(原batchId)
```

---

## 11. Web 管理端

技术：React 18 + Vite + Tailwind；构建产物由 Server 托管（`/`），开发时 Vite proxy 到 Server。**全站只读 + 「发起执行」类操作，无任何用例编辑入口。**

| 路由 | 页面 | 关键交互 |
|------|------|---------|
| `/cases` | 用例库 | 左侧 project/分组树 + tag 多选（any/all）+ 关键字；右侧表格（ID、标题、tags、超时、最近结果）；详情抽屉：元数据 + 只读代码高亮 + 最近 10 次执行；顶部「同步」按钮与最近同步状态/git commit/invalid 提示 |
| `/runs` | 测试运行列表 | 默认 20 条分页；可按状态 / 项目 / worker / 来源 / 关键字筛选；统计徽章（pass/fail）、created_by、耗时 |
| `/runs/:id` | 测试运行详情 | 概要卡（进度条、pass/fail/skip、params、git commit、归属项目）；items 表 WS 实时刷新；running 行「📺 实时画面」按钮；终态行展开：错误信息、失败截图、trace 链接、视频、日志；操作：取消 / 重跑失败 |
| `/workers` | Workers | 在线状态、当前执行用例、版本、心跳、累计统计 |
| 实时画面弹窗 | - | 订阅 `run:<id>` 帧事件，`<img>` 追帧 + 帧率/延迟指示；关闭即退订 |

创建测试运行对话框：project **必选**（一次运行一个项目）→ version / module 可多选 → tag 筛选（any/all、排除）→ Worker（全部空闲并行 / 指定一个）→ 命中用例数实时预览 → params（k=v）→ 重试次数 → 提交即跳运行详情页看实时进度。添加 git 项目时可配 HTTP 账号密码或 SSH 私钥。

---

## 12. Coding Agent 友好性设计

1. **`AGENTS.md`（仓库根）** 是 Agent 的第一入口，包含：项目一句话说明；如何写用例（规范速查 + 最小模板 + `tern new case`）；如何执行（MCP / CLI 命令 + wait 语义）；目录结构图；约定（ID=路径、超时默认、tag 建议：`smoke`/`p0`/`v*`/模块名）；常见错误对照表（invalid 原因 → 怎么改）。
2. **一切接口 JSON**、错误结构统一、分页/排序确定；列表默认按创建时间倒序。
3. **确定性 ID**：case id = 文件路径（可预测）；batch/run/worker = ULID（可排序、URL 安全）。
4. **快速反馈回路**：写完用例 → resync 立刻知道 lint/编译结果；跑完失败 → MCP 直接返回截图 image content + trace。
5. **`tern` CLI**（与 MCP 同一 API client）：`tern sync` / `cases list|show` / `run --project --tags --case --params k=v --wait --json` / `batch show|wait|cancel` / `failures <batchId> --screenshots` / `new case --project --group --name`（生成模板）/ `worker reupload`。全部支持 `--json`，便于脚本与 CI。
6. **CI 友好**：`tern run --wait --json` 退出码 = 失败用例数（0 为通过），可直接接入任何 CI；批次报告有 `batch-report.json`。
7. **平台自检（dogfood）**：仓库自带 `cases/platform/` 自检用例集（对内置 demo 页面断言），CI 中用平台自身跑，既验证平台又示范规范。

---

## 13. 代码仓库结构

```
Tern/
  package.json               # pnpm workspace 根
  pnpm-workspace.yaml
  tsconfig.base.json
  AGENTS.md                  # Agent 第一入口（§12）
  README.md
  .gitignore
  docs/
    tech-design.md           # 本方案
    case-spec.md             # 用例编写规范（M1 从本文 §4 细化拆出）
    api.md                   # REST/WS/MCP 接口明细（M4 生成）
  apps/
    server/                  # Fastify：API/WS/调度/同步/产物/静态托管
      src/{api,ws,scheduler,sync,db,artifacts}/...
      migrations/            # 手写 SQL 迁移（001_init.sql ...）
    worker/                  # Worker 进程：连接、领任务、调 exec-kit、回传
    web/                     # React 管理端（构建产物由 server 托管）
    mcp/                     # MCP server（stdio，REST 瘦封装）
  packages/
    sdk/                     # 共享类型 + API client（mcp/cli/worker 复用）
    exec-kit/                   # Worker 执行管理层：runner config 模板、事件 reporter、CDP screencast 侧车、进程看护
    case-bundler/            # esbuild 封装 + 用例 lint
    cli/                     # tern 命令行
  cases/                     # ★ 用例库（Git 管理，Agent 直接编辑）
    package.json
    _lib/
    portal/login/login-basic.spec.ts
    platform/…               # 平台自检用例
  data/                      # 运行时数据（gitignore）：db / bundles / artifacts / tmp
```

各包保持小而清晰：server ≈ 调度+API，worker ≈ 连接与子进程编排，exec-kit ≈ Worker 执行管理层（config/reporter/CDP 采集/进程看护，可单测），sdk 无状态。

---

## 14. 配置项

| 变量 | 组件 | 默认 | 说明 |
|------|------|------|------|
| `PORT` | server | `7430` | HTTP/WS 端口 |
| `HOST` | server | `0.0.0.0` | |
| `DATA_DIR` | server/worker | `./data` | 运行时数据根目录 |
| `CASES_DIR` | server | `./cases` | 用例库路径（可指向外部仓库 checkout） |
| `WORKER_TOKEN` | server+worker | 自动生成 | Worker 接入凭证 |
| `API_TOKEN` | server | 空（不启用） | 启用后写操作需 Bearer |
| `SYNC_WATCH` | server | `true` | fs.watch 自动同步 |
| `CASE_DEFAULT_TIMEOUT_S` | server | `120` | 无 frontmatter 时的默认超时 |
| `MAX_BATCH_ITEMS` | server | `2000` | 单批次上限 |
| `ARTIFACT_RETENTION_DAYS` | server | `14` | 产物保留天数 |
| `SERVER_URL` | worker | 必填 | 如 `http://10.0.0.5:7430` |
| `WORKER_NAME` | worker | hostname | |
| `BROWSER` | worker | `chromium` | |
| `MAX_SLOTS` | worker | `1` | 并发执行槽（协议已预留） |
| `HEARTBEAT_MS` | worker | `10000` | |
| `ARTIFACT_MODE` | worker | `upload` | `upload` / `shared`（共盘直写） |
| `CASE_HARD_TIMEOUT_S` | worker | `600` | 单条用例（整个脚本文件）墙钟上限，超时杀 runner 进程组 |
| `TERN_URL` / `TERN_TOKEN` | mcp/cli | - | 平台地址与可选凭证 |

---

## 15. 安全模型

- **信任边界**：内网工具。用例代码本来就在 Git 仓库中，Worker 执行仓库代码是产品本意——Worker 应部署在内网可信环境（容器隔离更佳），不对公网暴露 Server。
- Worker 接入强制 `WORKER_TOKEN`；playwright 版本不匹配拒绝接入。
- 产物服务：Content-Type 白名单 + `X-Content-Type-Options: nosniff`；源码/日志一律 `text/plain` 渲染，杜绝存储型 XSS；`/artifacts` 开 CORS 仅为 trace viewer 加载（可配置关闭）。
- 上传文件名白名单校验（防路径穿越）+ 单 run 100MB 上限。
- `params` 明文入库——文档明确：不要放生产密钥（测试凭据以外的敏感信息走环境变量/密钥系统，未来再加 secrets 引用）。
- Web 无登录体系（内网信任）；预留 `API_TOKEN` 作为最小防护；`/ws/app` Origin 校验。

---

## 16. 非目标与未来扩展

**当前明确不做（Non-goals）：** 用户/权限体系、多租户、定时触发（cron）、IM 通知集成、跨浏览器矩阵、对象存储、多 Server 水平扩展、用例参数化（`variants`，frontmatter 已预留）、性能/压测。

**未来方向：** 定时批次与 webhook 通知；flaky 用例统计分析（按 case 聚合历史通过率）；趋势报表；参数化用例；Firefox/WebKit（capabilities 协议已预留，实时画面仅 Chromium）；自托管 trace viewer 资源。

---

## 17. 里程碑与实施计划

| 里程碑 | 内容 | 验收标准 | 预估 |
|--------|------|---------|------|
| M0 脚手架 | monorepo / TS / lint / CI 骨架 / AGENTS.md 初版 | `pnpm i && pnpm build` 全绿 | 0.5d |
| M1 用例库 | frontmatter 解析、lint、同步、bundle、SQLite 迁移、只读 Web 用例浏览 | 增删改 cases 文件后 ≤3s UI 可见；invalid 用例展示精确错误 | 2d |
| M2 执行链路 | WS 双通道、调度（租约/run_token）、exec-kit（config 生成/事件 reporter/进程看护）、批次创建、结果页、实时进度、失败截图/trace/日志（runner 原生） | 单 Worker 跑 10+ 用例批次 UI 全程实时刷新；`kill -9` Worker 后任务正确重派 | 3d |
| M3 实时画面 | screencast 采集/转发/按需开关/弹窗；trace 在线回放 | 观战端到端延迟 < 1s；无观战时零开销；只读 | 1.5d |
| M4 MCP + CLI + 加固 | MCP tools、tern CLI、取消/重试/恢复完备、产物上传与补传 | 用 MCP 完成「查询→执行→看失败截图→重跑」完整闭环 | 1.5d |
| M5 完善与自检 | docs（case-spec/api）、保留清理、平台自检用例集 | CI 用平台自身跑自检用例全绿 | 1d |

合计约 **9.5 人日**。每个里程碑结束产出可运行版本，M2 起即可日常使用。

---

## 18. 风险与开放问题

| 风险 | 影响 | 缓解 |
|------|------|------|
| screencast 带宽/性能 | 观战卡顿、Worker CPU 占用 | 限帧 ≤5fps、jpeg q50、按需采集（无人观看即停）、Server 扇出不放大上行 |
| bundle 兼容性（ESM/CJS、动态 require、原生依赖） | 个别用例打包失败 | 白名单 lint + 同步期精确报错；`_lib` 走同一管线提前暴露 |
| Playwright 版本漂移（Server externals vs Worker 安装版） | 运行时 API 不匹配 | 仓库锁版本 + hello 阶段校验、不匹配拒绝接入 |
| trace.playwright.dev 为外站 | 内网环境无法加载 | 自托管 trace viewer 静态资源（M5） |
| 视频体积 | 磁盘膨胀 | 默认关视频、批次级开关、保留策略清理 |
| 多进程写 SQLite | 数据损坏 | 设计上单 Server 进程写；文档明令禁止多实例 |
| bundle 产物 × playwright loader 兼容性（esbuild 产物作为测试文件被 runner 加载） | 个别用例无法执行 | M2 第一项任务即端到端验证；若不兼容，退化为「下发依赖文件集」方案（用 esbuild metafile 计算依赖，按目录结构落盘到 tmp） |
| Worker 本机 CDP 端口冲突 | 侧车连不上、无实时画面 | 从端口区间随机分配并探活，冲突自动换位；仅监听 127.0.0.1 |

**开放问题（待评审拍板）：**

1. Worker `MAX_SLOTS > 1` 的并发执行是否值得做（初期 1 Worker 1 槽，横向加 Worker 扩容是否已足够）；
2. 批次定时触发（cron）是否很快会需要——若需要，M4 顺带做（Server 内置简易调度即可）；
3. 用例间依赖：当前立场是**永不支持**（保持独立性），确认无异议；
4. 部署形态：物理机 / 容器（docker-compose：server + N worker）是否需要平台直接提供编排文件。
