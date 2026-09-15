# AGENTS.md —— Coding Agent 工作指南

本仓库是 **Tern**（北极燕鸥 · E2E 测试平台）：一套面向 Coding Agent 的 E2E 测试平台。**用例放在独立的用例仓库里（一个 git 仓库 = 一个 project）**，你（Agent）直接在用例仓库里读写 Playwright 测试文件并 push；平台负责拉取、索引、调度、执行和汇聚结果。

本文件覆盖两类任务：**写用例**（在用例仓库里，见前文约定）与**改平台代码**（在本 monorepo 里，见文末「仓库结构与包边界」「本地开发」）。

## 30 秒上手

1. **确认项目**：`tern projects list`（或 MCP `tern_list_projects`）。没有想要的 project？`tern projects add <git-url>`（或 MCP `tern_add_project`；私有仓库加 `--user/--password` 或 `--ssh-key-file`，容器内不用宿主机密钥）。
2. **写用例**：在用例仓库的 `cases/<分组>/.../<case-name>.spec.ts` 创建文件（文件名小写 kebab-case），头部写 `@tern` 注释块（元数据），正文用**原生 Playwright 语法**；push 到远端。
3. **让平台生效**：`tern projects sync <project>`（或 MCP `tern_sync_project`；平台也会按间隔自动强制拉取）。立即知道 lint/编译是否通过。
4. **执行**：`tern run --case <caseId> --wait`（或 MCP `tern_run_cases`，wait 语义直接返回结果；可 `--worker` 指定执行节点、`--env` 引用平台环境、`--suite` 引用测试集可多个）。
5. **看失败**：`tern failures <runId>`（或 MCP `tern_get_failure_summary` 按错误签名分组、`tern_get_execution` / `tern_get_screenshot` 看失败截图；Web 端 trace 支持在线查看）。
6. **修复后重跑**：`tern retry-failed <runId>`（或 MCP `tern_retry_failed`）只重跑失败用例；`tern rerun <runId>`（或 MCP `tern_rerun`）全量重跑。二者沿用源运行的环境/参数/worker/trace 选项；Web 端在运行详情页与运行列表行内有对应按钮。

## 环境（env）

- 用例仓库 `tern.yaml` 的 `env.variables` 节点声明**变量清单**（名/说明/`secret: true`）——清单在仓库，值在平台。
- 平台侧按项目定义多个**环境**（值集，secret 值 AES-GCM 加密存储、API 不回显）：Web 项目页「环境/通知」、`tern env create <project> <env> --set K=V --set-secret K=V`、MCP `tern_list_environments`。
- 运行引用环境：`tern run --env staging` / `tern_run_cases(env)`；环境值缺齐时创建即报错（fail-fast）；运行参数显式传值优先于环境值。

## 测试集（suite）

- **可命名的用例选择 + 执行前提绑定**（docs/test-suite-design.md）：selector = 筛选（tags/version/module/q）+ 显式包含/排除（`includeCaseIds`/`excludeCaseIds`，**排除优先**）；空选择器 = 项目全量；一个测试集只属于一个 project。
- 集可绑定 `env` / `account`（AUTH_ACCOUNT，只覆盖未声明 auth 的用例）/ `params`——run 引用该集时的缺省值，运行参数显式覆盖。
- **多集多环境并跑**：`tern run --suite smoke --suite regression` 各用各的 env，按「用例 × 环境」去重执行（同用例同环境只跑一次，跨环境各跑一次）；run 显式 `--env` = 覆盖拉平为单一环境。同环境内账号/参数不一致 → 创建即 400（fail-fast）。
- 管理：Web 顶部导航「测试集」页（按项目维度管理 + 实时命中预览）、`tern suites <project> list|show|create|update|rm|preview`、MCP `tern_list_suites` / `tern_create_suite` 等；`POST /runs/preview`（MCP `tern_preview_run`）dry-run 看命中构成；定时任务 scope 可写 `suites: [名]`。

## 用例仓库规范

仓库根目录放 `tern.yaml` 描述项目 meta；用例默认放 `cases/`：

```yaml
# tern.yaml
name: portal # 必填，全局唯一，kebab-case（也是 caseId 第一段）
description: 门户前端 E2E
casesDir: cases # 可选，默认 cases
defaultTags: [demo] # 可选，合并进每个用例的 tags
auth: # 可选，登录配方（拍平结构，有顶层 mode = 单配方；见下）
  mode: api
  method: GET
  url: /api/auth/mock-login # 相对路径拼接运行参数 BASE_URL
  query:
    clientId: ${account.clientId} # ${account.x} 从当前账号解析
  success:
    cookie: session_token # 响应必须种出的 cookie
    json: success # JSON 路径必须为真值（统一响应信封）
  validate: /api/auth/findUserLoginInfo # 会话校验；失效按原配方重登
  accounts: # 账号表；不写 auth 的用例走 default
    default:
      clientId: ${ENV:CLIENT_ID}
    admin:
      clientId: ${ENV:ADMIN_CLIENT_ID}
```

配方较长时可把 `auth` 拆到仓库根 `auth.yaml`（存在时整段覆盖 `tern.yaml` 的 `auth`）。

## 用例文件模板

```ts
/**
 * @tern
 * title: 登录 - 正确账号密码登录成功
 * description: 一句话说明测什么
 * tags: [smoke, login]     # 自由标签；与 version/module 组成多维筛选
 * version: v2.3            # 被测系统版本（可选，多维度筛选用）
 * module: login            # 功能模块（可选）
 * auth: admin             # 不写 = 默认登录；none = 不登录；其他 = 账号/配方名（可选）
 * timeout: 60              # 秒，可选，默认 120
 * retries: 0               # runner 内重试次数，可选
 * author: agent
 */
import { test, expect } from '@playwright/test';
// 可 import：@playwright/test、node: 内置、相对路径（仓库 _lib 工具库）、
// 仓库 package.json 中声明的依赖。禁止 import 平台内部模块（@tern/*）。

test('用例名', async ({ page }) => {
  // 原生 Playwright 语法；声明了 auth 时 page 已带登录态
});
```

## 登录方式（auth）

登录流程不写进用例。在用例仓库 `tern.yaml` 的 `auth:` 下声明**登录配方**（拍平结构，设计见 `docs/auth-design.md`），Worker 执行前建立登录态（playwright storageState）注入，登录一次按需重登：

- `mode: api`——接口登录：请求登录接口（支持 GET + query，如快捷登录 `GET /api/auth/mock-login?clientId=…`），按重定向链收集 Set-Cookie 并入 storageState；`success.cookie` / `success.json` 判定成功（部分业务失败仍 HTTP 200，不能只看状态码）。
- `mode: form`——表单登录：无头浏览器真实走登录页（`user`/`pass`/`submit` 选择器 + `success: {url, locator}` 判定）；失败留截图 + trace。
- `mode: storage`——直写：直接声明 `cookie` / `cookies` / `localStorage`（长期 token 场景；domain/origin 缺省从 BASE_URL 推导）。

引用规则（用例 frontmatter `auth:`）：**不写 = 默认登录**（单配方 + `default` 账号）；`auth: none` = 不登录；`auth: admin` = 单配方下的账号名（`accounts` 表）或多配方下的配方名。运行参数 `AUTH_ACCOUNT` 只覆盖「没写 auth」的用例。

会话复用：默认 `reuse: worker`——每个 worker 在本 run 内，同一「配方 + 账号 + 环境」只登一次；配置 `validate`（URL）时缓存会话先校验，失效按原配方重登；`reuse: never` 每条用例都登。改 yaml 要下一轮运行生效（创建 run 时现读快照）；改本次的 clientId/token 只改**运行参数**。

凭据一律写 `${ENV:VAR}` 占位符，在 Worker 端从运行参数/环境变量解析——**凭据不进 git、不落库**。变量缺失 → 该次执行以 `AuthError` 失败，错误信息含变量名。

## 规范与约定

| 约定        | 说明                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case ID     | = `<项目名>/<文件相对 cases/ 的路径>` 去扩展名，如 `portal/login/login-basic`（可预测，无需查库）                                                                                     |
| 粒度        | 一个 `.spec.ts` 文件 = 一条平台用例；文件内可写多个 `test()`（顺序执行，任一失败则用例失败）                                                                                          |
| 多维筛选    | `project` / `version`（被测系统版本）/ `module`（功能模块）/ `tags`（自由标签）组合筛选，CLI/API/MCP/Web 一致                                                                         |
| 命名        | 目录与文件名小写 kebab-case（`[a-z0-9-]`）；`_` 前缀目录是用例间共享的工具库，不参与调度                                                                                              |
| 参数        | 测试运行参数经环境变量注入；`BASE_URL` 自动映射为 `page` 的 baseURL（auth 的相对地址也用它拼接），其余用 `process.env.XXX ?? 默认值`                                                  |
| 独立性      | 用例之间禁止任何依赖与顺序假设（平台不保证顺序与所在机器）                                                                                                                            |
| 日志        | 用 `console.log`（实时回传）与 `test.step()`（步骤时间线）                                                                                                                            |
| 产物        | 失败自动截图 + trace（runner 原生）；自定义产物用 `testInfo.attach()`                                                                                                                 |
| 跳过 / 停用 | 原生 `test.skip()` / `test.fixme()` → `skipped`；frontmatter `disabled: true` → 不参与调度                                                                                            |
| 测试资产    | `cases/_assets/` 目录随仓库打包（sync 内容寻址入库，随任务下发 worker）；用例内 `ternAsset('相对路径')` 取本地绝对路径（API 播种/上传 fixture 通用）；详见 docs/test-assets-design.md |
| 设备模拟    | frontmatter `devices: {mic: audio/x.wav}` / `[mic]` → fake 麦克风/摄像头（WAV 文件以真实 PCM 推流进 getUserMedia，ASR 可转写真实内容）；run options `devices` 可全 run 覆盖           |

## sync 错误对照

| 现象（sync 报告）                  | 原因与修法                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `缺少必填字段 title`               | frontmatter 补 `title:`                                                                  |
| `路径段 "X" 不符合小写 kebab-case` | 重命名目录 / 文件                                                                        |
| `import "X" 不在白名单内`          | 依赖加进用例仓库 `package.json` 的 `dependencies`，或改用 `_lib` 相对路径                |
| `禁止 import 平台内部模块`         | 删除对 `@tern/*` 的 import                                                               |
| `META - frontmatter YAML 解析失败` | YAML 字符串里有裸 `: `，给值加引号或改写（半角冒号+空格会被当成嵌套映射）                |
| `AUTH_PROFILE_NOT_FOUND`           | frontmatter `auth:` 引用的名字不存在（单配方 = `accounts` 里的账号名 / 多配方 = 配方名） |
| `环境变量 CLIENT_ID 未设置`        | 运行参数或 worker 环境缺少 `${ENV:CLIENT_ID}`；检查环境配置                              |
| `未找到匹配的用例`（创建 run 时）  | 检查 tags/version/module 拼写与大小写（区分大小写）                                      |
| `devices.mic 需要 WAV（PCM）文件`  | `ffmpeg -i in.mp3 -ar 16000 -ac 1 -sample_fmt s16 out.wav` 转换                          |
| `ASSET_NOT_FOUND`（创建 run 时）   | 资产被删或未同步：重新 push/sync 项目                                                    |

## 执行与结果

- **MCP**（推荐）：tools 以 `tern_` 前缀命名（含 `tern_add_project` / `tern_sync_project` 项目管理、`tern_list_environments` 环境、`tern_list_suites` / `tern_create_suite` 测试集、`tern_get_failure_summary` 失败分组、`tern_preview_run` 运行前 dry-run 预览），`tern_run_cases` 的 `wait=true`（默认）阻塞到测试运行结束并返回逐用例结果；一次运行只归属一个 project，可多 version/tag/suite（多集各带环境按「用例×环境」去重），`workerId` 缺省则全部空闲 worker 并行；`tern_get_screenshot` 直接返回失败截图；`tern_delete_run` 删除运行及产物；`tern_set_case_quarantine` 手动隔离 flaky 用例。
- **CLI**：`node packages/cli/dist/index.js <cmd>`（或全局 link 后 `tern`）。`projects add/sync/remove/rename`、`run --project p --env <name> --suite <名>（可多个） --worker <id|名> --wait --json`（退出码 = 失败用例数）、`cases list --version v2 --module login`、`runs list/delete --suite <名>`、`suites <project> list/show/create/update/rm/preview`、`env list/create/set/rm`、`schedules create/pause/resume/rm`、`cases quarantine/unquarantine`。
  - **项目改名**：`tern projects rename <id|name> <newName>`（或 `PATCH /api/v1/projects/:id {name}`）——项目名是 caseId 第一段，改名后平台**自动重新同步**：用例以新前缀（`新项目名/…`）重新入索引，旧 caseId 软删除成为历史；环境/测试集/定时/webhook 等按项目 id 关联的数据不受影响。git 项目的注册名与仓库 `tern.yaml` 的 `name` 不一致时**以注册名为准**（sync 只告警）——两边对齐的方式：先改仓库 `tern.yaml`，再 rename 注册名。
- **Web**：`http://<server>:7430`（本地实例默认：<http://127.0.0.1:7430/>）—— 项目管理（添加 git 仓库 + HTTP 账号密码 / SSH 私钥、手动更新、**环境与通用 Webhook 通知配置**、**测试集**管理与命中预览）、用例库分页筛选（flaky 率/隔离）、测试运行实时进度 + 执行中只读实时画面（多环境运行条目带 env 徽标）、失败截图/**失败分组**/trace 在线查看、定时任务页（可引用测试集）、Workers 状态。用例代码仍然只读（在用例仓库里改）。
- **定时与通知**：平台支持 cron 定时运行（防重叠）与通用 Webhook / 钉钉机器人通知（完成/失败时推送摘要）。

## 仓库结构与包边界（改平台代码先读）

pnpm monorepo（`apps/*` + `packages/*`；Node ≥ 20，pnpm@10；ESM + NodeNext，strict TS，公共配置在 `tsconfig.base.json`）：

| 目录                    | 包名                 | 职责                                                                                      |
| ----------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `packages/sdk`          | `@tern/sdk`          | 共享类型 + API 客户端，**零依赖叶子包**                                                   |
| `packages/case-bundler` | `@tern/case-bundler` | 解析用例仓库（`tern.yaml` / `@tern` frontmatter）+ esbuild bundle；单测在此               |
| `packages/exec-kit`     | `@tern/exec-kit`     | Worker 侧执行套件（playwright-core）；构建会额外拷贝 `src/reporter.cjs` → `dist/`         |
| `packages/cli`          | `@tern/cli`          | CLI（bin `tern`）                                                                         |
| `apps/server`           | `@tern/server`       | Fastify + better-sqlite3，端口 7430：项目管理、调度、WS 推送、托管 Web 构建产物；单测在此 |
| `apps/worker`           | `@tern/worker`       | 被动执行节点（只出站连接），跑 Playwright                                                 |
| `apps/web`              | `@tern/web`          | React + Vite + Tailwind 管理端                                                            |
| `apps/mcp`              | `@tern/mcp`          | MCP server（bin `tern-mcp`）                                                              |

依赖方向：`sdk` 是叶子，禁止反向 import 其他包；`server → case-bundler`、`worker → exec-kit`，`cli`/`mcp` 只依赖 `sdk`。单元测试是 `*.test.ts`，经编译后从 `dist/` 运行（`node --test .../dist/*.test.js`）——**跑 `test:unit` 前必须先 `pnpm build`**。

运行时数据（均已 gitignore）：`data/`（SQLite、执行产物、首启自动生成的 `data/.worker-token`）、`repos/`（server clone 的用例仓库，sync 时 `reset --hard + clean`）、`apps/server/public/`（web 构建输出）。

## 本地开发

```bash
pnpm install && pnpm build     # 构建全部包
pnpm test:unit                 # 单元测试（case-bundler / server；从 dist 跑，先 build）
pnpm test:e2e                  # 端到端（脚本拉起真实 server/worker/demo 站点）
pnpm test                      # 单元 + 端到端
# 手动起服务：
pnpm start:server              # http://127.0.0.1:7430（REPOS_DIR 默认 ./repos；首启自动生成 WORKER_TOKEN）
pnpm start:worker              # SERVER_URL=... WORKER_TOKEN=... node apps/worker/dist/index.js
pnpm --filter @tern/server dev # server watch 重启（node --watch dist；改代码后仍需 tsc 重新编译）
(cd apps/web && pnpm dev)      # Web 独立 dev（5173，/api /ws 代理到 7430）
node scripts/demo-site.mjs     # 本地演示站点（带登录，供 tests/fixtures/demo-cases-repo 用例使用）
```

首次运行需 `npx playwright install chromium`（worker 所在机器）。

部署走 Docker（`docker-compose.yml`、`scripts/docker-build.sh` / `docker-smoke.sh`），见 `docs/deploy.md`；平台架构详见 `docs/tech-design.md`，登录配方设计见 `docs/auth-design.md`。
