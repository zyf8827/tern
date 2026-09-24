---
name: tern-project
description: '创建或修改 Tern E2E 测试平台的用例项目（tern project）：初始化用例 git 仓库（tern.yaml + cases/ + 登录配方）、按 @tern frontmatter 规范编写 Playwright 用例（含 devices 设备模拟与 ternAsset 测试资产）、接入 Tern 平台并同步、发起测试运行与分析失败、创建/引用平台测试集（多集多环境并跑）。Use when 新建 tern project、写 Tern 用例、改 tern.yaml 登录配方、项目接入/同步 Tern 平台、修复用例 lint 或运行失败、设备模拟/资产引用用例、真实环境实跑失败定位、建测试集/按测试集发起回归等场景。'
argument-hint: '[项目名或用例仓库路径] <要做的事>'
user-invocable: true
---

# Tern Project

## When to Use

- 新建一个 Tern 用例项目：从零搭建 `tern.yaml`（含 auth 配方与 env 变量清单）+ `cases/` 骨架并接入 Tern 平台。
- 在已有项目里新增 / 修改用例，或调整 `module` / `version` / `tags` 等多维筛选字段。
- 新增或修改登录配方（`auth:` 的 `api` / `form` / `storage` 三种模式，详见 `references/auth-recipes.md`）。
- 设计或调整运行变量清单（`env.variables` 声明哪些变量、哪些标 secret，详见 `references/env-variables.md`）。
- 创建或修改平台**测试集**（可命名的用例选择 + 环境/账号绑定，一次 run 引用多集多环境并跑），详见 `references/test-suites.md`。
- 编写带设备模拟（`devices:` fake 麦克风/摄像头）或测试资产（`ternAsset()`）的用例。
- 用例在真实环境执行失败，需要定位是环境问题、被测系统问题还是用例写法问题（踩坑对照见 `references/case-pitfalls.md`）。
- 同步后出现 lint / 编译报错，或运行失败需要按平台约定修复。

前提：Tern 平台（server + worker）已部署，能通过 MCP（`tern_*` 前缀工具）或 CLI `tern` 访问。MCP 与 Skill 的安装指引见 `docs/skills.md` 与 `docs/mcp.md`。

**使用环境**：默认指向本地平台 <http://127.0.0.1:7430>（或团队私有部署地址）。浏览器打开同一地址可人工查看运行进度、失败截图与 trace。本地 / 自建平台时经 `TERN_URL` 环境变量覆盖。

## Operating Rules

- **一个 git 仓库 = 一个 project**：仓库根必须有 `tern.yaml`（至少 `name:`，全局唯一，小写 kebab-case，也是 caseId 第一段）。平台侧 clone 是只读的（定期 `reset --hard + clean`），一切修改都在用例仓库里做，改完 push。
- **一个 `.spec.ts` 文件 = 一条平台用例**：Case ID = `<项目名>/<相对 cases/ 的路径去扩展名>`（如 `portal/login/login-basic`），可预测无需查库。文件内可写多个 `test()`（顺序执行，任一失败则该用例失败）。
- **命名**：目录与文件名一律小写 kebab-case（`[a-z0-9-]`）；`_` 前缀目录是用例间共享的工具库，不参与调度。
- **登录流程不进用例**：登录写在 `tern.yaml` 的 `auth:` 配方里，用例只通过 frontmatter `auth:` 引用；凭据一律写 `${ENV:VAR}` 占位符，真实值通过运行参数 / worker 环境注入——**凭据不进 git、不落库**。
- **变量清单在仓库、环境值在平台**：`tern.yaml` 的 `env.variables` 节点声明项目需要哪些变量（`secret: true` 标记凭据类）；在 Tern 平台侧按项目创建**环境**并填值（secret 值加密存储、不回显），发起运行时用环境名引用。缺值环境在创建运行时即报错（fail-fast）。
- **哪些进变量清单**（详见 `references/env-variables.md`）：① 换环境值会变的输入——地址类（`BASE_URL` 必有，是被测入口；直调后端加 `API_BASE_URL`）、环境特征类（租户 ID、功能开关、测试数据定位）；② 凭据即使各环境相同也必须走变量（值不进 git）；③ 用例/配方读了 `${ENV:X}` / `process.env.X`，X 就进清单。反例：选择器、断言预期、与环境无关的超时——写死在用例里。**进清单 = 每个环境必须配齐**；真正可选的输入不进清单，用例 `process.env.X ?? 默认值` 自给。
- **import 白名单**：`@playwright/test`、`node:` 内置模块、相对路径（`_lib` 工具库）、用例仓库 `package.json` `dependencies` 里声明的包；**禁止 import 平台内部模块（`@tern/*`）**。
- **资产引用只认字符串字面量**：`ternAsset('audio/x.wav')` 必须以字面量形式出现在**用例文件**里（`devices:` frontmatter 同理）。不要把 `ternAsset` 包进 `_lib` 函数内部用参数传相对路径——引用扫描看不见，资产不会随 run 下发（详见 `references/case-pitfalls.md` §1）。`_lib` 函数应接收 buffer/本地路径，由调用方先字面量解析。
- **devices 用例的环境前置**：getUserMedia 要求 secure context——`http://<IP>:port` 直连会被浏览器禁止录音/拍照（用例全体超时且 REST 无异常）。**平台已内建设备反向代理（F9）**：worker 自动经本机 `127.0.0.1` 代理访问并重写运行参数，`device_proxy_mode` 设置控制（默认 auto 按需），环境 BASE_URL 填真实地址即可；旧版平台才需手动本地反代（详见 `references/case-pitfalls.md` §3）。
- **frontmatter YAML 值里不要出现裸 `: `**（半角冒号 + 空格会被当成嵌套映射，sync 报 `META - frontmatter YAML 解析失败`）。
- **筛选维度各管一事，不要互相重复**：`module`（功能模块，与 `cases/` 一级目录一致）回答「测哪个功能分区」，`version`（可选）回答「适用被测系统哪个版本」——仅版本适用性有约束时写，通用用例不写；`tags` 只放横切属性：驱动方式（`api`/`ui`）、执行分层（`smoke`）、性质（`negative`）、资源（`device`/`slow`）、跨模块关联。**禁止把模块名写进 tags（与 module 重复）、把项目名写进 tags 或 defaultTags（与 project 重复）**——否则详情页出现同名双 chip，筛选语义含混。
- **稳定口径沉淀为测试集，不加维度**：反反复复要跑的固定组合（冒烟、某环境专属、特定账号成组）→ 平台侧建测试集（`tern_create_suite`，详见 `references/test-suites.md`）；不要为了「好选」往用例里塞新 tags 或改 module——那是用例自描述，测试集是对它们的组合引用。
- **用例独立性**：禁止用例间的顺序与依赖假设（平台不保证顺序与所在机器）；参数经环境变量注入，`BASE_URL` 自动作为 `page` 的 baseURL，其余用 `process.env.XXX ?? 默认值`。
- **改完必验**：push → `tern_sync_project`（立即暴露 lint/编译错误）→ `tern_run_cases`（wait 语义）→ 失败看截图与日志再修。

## Workflow

### A. 创建新项目

1. **收集信息**（缺什么向用户要，不要编造凭据值）：
   - 被测系统地址（将成为变量 `BASE_URL`——E2E 测什么由它决定）；若有直调后端/第三方服务的用例，一并要地址；
   - 登录方式：调登录接口（`api`）/ 真实表单登录（`form`）/ 已有长期 token（`storage`）；
   - 每个身份的凭据对应的**环境变量名**（如 `CLIENT_ID`、`ADMIN_USER`）——只要变量名，不要真实密码；
   - 环境特征输入（有才要）：租户/设备 ID、各环境功能开关、预置测试数据定位。
2. **搭骨架**（模板在本 skill `assets/` 下）：
   - `tern.yaml` ← `assets/tern.yaml.template`（name + description + env.variables 变量清单 + auth 配方；清单把用例/配方用到的 `${ENV:VAR}` 全部声明进去，凭据类标 `secret: true`）；
   - `package.json`（`private: true`，`dependencies` 只放用例真正 import 的包）；
   - `.gitignore`、`AGENTS.md` ← `assets/case-repo-AGENTS.md.template`（给后续在这个仓库干活的 Agent 留规范）；
   - `cases/<模块>/…`：第一条用例建议做成**登录自检**（断言会话接口返回或登录后页面元素），用它验证 auth 配方。
3. **写 auth 配方**：按 `references/auth-recipes.md` 选 mode、写字段；配方较长可拆到仓库根 `auth.yaml`（存在时整段覆盖 `tern.yaml` 的 `auth`）。
4. **git init + push** 到远端 Git 托管平台（GitHub 等），拿到 clone URL。
5. **接入平台**：MCP `tern_add_project`（传 gitUrl + 认证）或 CLI `tern projects add <git-url>`。注意 worker/server 跑在容器里**不会用宿主机密钥**：私有仓库要显式给 HTTP 账号密码（`credentialType: password`）或 SSH 私钥 PEM 全文（`credentialType: ssh`）。
6. **配环境并冒烟**：在平台创建环境并填值（Web 项目页「环境」，或 CLI `tern env create <project> <env> --set BASE_URL=… --set-secret CLIENT_ID=…`）；然后 `tern_run_cases`（指定 project 与 `env`，建议 tags=smoke，wait 默认开启）确认登录与首条用例通过，再交付。之后运行统一带 `env`，无需再传参数。
7. **沉淀测试集（口径固化后）**：冒烟集（`tags: [smoke]` + 核心链路点名）、模块回归集、带环境/账号前提的成组用例 → `tern_create_suite` 建集并绑定 env/account（判定标准与多集多环境并跑语义见 `references/test-suites.md`）；建集前先 `tern_preview_run` 看命中构成。之后日常回归一律按集发起（`tern_run_cases(suites=[…])`）。

### B. 修改已有项目

1. **定位**：clone 用例仓库；可先用 MCP `tern_list_cases` / `tern_get_case` 看平台上现有的用例元数据与源码。
2. **断言前先实探**：对要新断言的接口，先用真实环境 `curl` 一次看响应结构——**不要照前端 service 层的 JSDoc/注释写**（实测存在文档与真实结构不符）；被测系统的统一信封语义（业务失败是否仍 HTTP 200）也要实测核实。
3. **修改**：新用例放进合适的 `cases/<模块>/`；改配方直接编辑 `tern.yaml`（或 `auth.yaml`）。注意 Case ID 由路径决定，**移动/重命名文件 = 用例 ID 变了**，历史记录不跟随。UI 断言注意组件库的坑（antd Radio 视觉隐藏、文案多处命中、弹窗 Upload 的事件注入，详见 `references/case-pitfalls.md` §2）。
4. **push → `tern_sync_project`**：sync 报告就是 lint/编译结果，报错按下文「sync 错误对照」修。共享库（`_lib`）变更会刷新引用它的用例 bundle。
5. **验证**：`tern_run_cases --wait`（多失败先 `tern_get_failure_summary` 看错误签名分组与跨 run 历史，再逐条 `tern_get_execution` / `tern_get_screenshot` 看现场）；修复后 `tern_retry_failed <runId>` 只重跑失败集。**注意 retry-failed 继承原 run 的参数快照**——改了环境值要发**新 run** 验证，retry 仍用旧值。
6. **改 auth/账号表**：推进仓库后**下一轮运行**才生效（配方在创建 run 时快照）；只改这次的 clientId/token 用**运行参数**，立刻生效。run 执行期间不要用同一账号手工登录（会互踢 worker 会话）。

## 用例文件模板

```ts
/**
 * @tern
 * title: 登录 - 正确账号密码登录成功        # 必填；格式建议「模块 - 断言」
 * description: 一句话说明测什么、怎么判定
 * tags: [smoke, login]     # 自由标签；与 version/module 组成多维筛选
 * version: v2.3            # 被测系统版本（可选）
 * module: login            # 功能模块（可选）
 * auth: admin              # 不写 = 默认登录；none = 不登录；其他 = 账号/配方名
 * # depends: [auth/login-page] # 串行依赖相对用例 ID 列表（同批同环境生效；未入选软跳过；依赖失败则跳过本条）
 * timeout: 60              # 秒，可选，默认 120
 * retries: 0               # runner 内重试次数，可选
 * author: agent
 */
import { test, expect } from '@playwright/test';

test('用例名', async ({ page }) => {
  // 原生 Playwright 语法；声明了 auth 时 page 已带登录态
  // console.log 实时回传；test.step() 进步骤时间线
});
```

## sync 错误对照

| 现象（sync 报告）                                    | 原因与修法                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `仓库根目录缺少 meta 文件`                           | 仓库根创建 `tern.yaml`（至少 `name:`）                                                                                                                                   |
| `未找到 @tern frontmatter 注释块`                    | 文件头部的块注释缺 `@tern` 标记行                                                                                                                                        |
| `缺少必填字段 title`                                 | frontmatter 补 `title:`                                                                                                                                                  |
| `路径段 "X" 不符合小写 kebab-case`                   | 重命名目录 / 文件                                                                                                                                                        |
| `import "X" 不在白名单内`                            | 依赖加进用例仓库 `package.json` 的 `dependencies`，或改用 `_lib` 相对路径                                                                                                |
| `禁止 import 平台内部模块`                           | 删除对 `@tern/*` 的 import                                                                                                                                               |
| `META - frontmatter YAML 解析失败`                   | YAML 值里有裸 `: `，给值加引号或改写                                                                                                                                     |
| `AUTH_PROFILE_NOT_FOUND`                             | frontmatter `auth:` 引用的名字不存在（单配方 = `accounts` 里的账号名 / 多配方 = 配方名）                                                                                 |
| `depends cycle: A -> B -> A`                         | 依赖成环；检查用例 frontmatter `depends` 解除闭环                                                                                        |
| `depends self-reference: X`                          | 用例 frontmatter `depends` 包含了自身；删除自身依赖                                                                                      |
| 执行报 `ternAsset("x") 不在本次下发的资产中`         | 引用不是字面量调用（被包进函数传参）——把 `ternAsset('x')` 字面量写进用例文件（见 `references/case-pitfalls.md` §1）                                                      |
| devices 用例集体超时且 REST 正常、页面卡「初始化中」 | BASE_URL 是 `http://<IP>` 非安全源，getUserMedia 被浏览器禁止——平台 F9 设备反向代理默认 auto 自动处理；仍失败则检查平台版本/设置 `device_proxy_mode` 是否为 off（见 §3） |
| 运行报 `AuthError: 环境变量 XXX 未设置`              | 运行参数或 worker 环境缺少 `${ENV:XXX}` 对应的值                                                                                                                         |

## 平台工具速查

| 动作        | MCP 工具                                                                                                | CLI                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 列出项目    | `tern_list_projects`                                                                                    | `tern projects list`                               |
| 接入项目    | `tern_add_project`                                                                                      | `tern projects add <git-url>`                      |
| 强制同步    | `tern_sync_project`                                                                                     | `tern projects sync <project>`                     |
| 查用例      | `tern_list_cases` / `tern_get_case`                                                                     | `tern cases list`                                  |
| 查/建测试集 | `tern_list_suites` / `tern_create_suite` / `tern_update_suite` / `tern_delete_suite` / `tern_get_suite` | `tern suites <project> list/show/create/update/rm` |
| 跑用例      | `tern_run_cases`（wait 默认开；`suites` 引测试集，可多集多环境并跑）                                    | `tern run --project p --suite smoke --wait`        |
| 运行前预览  | `tern_preview_run`（dry-run：总数/环境分组/去重明细）                                                   | `tern suites <project> preview`                    |
| 查运行      | `tern_get_run` / `tern_wait_run`                                                                        | `tern runs list [--suite 名]`                      |
| 失败分析    | `tern_get_execution` / `tern_get_screenshot`                                                            | `tern failures <runId>`                            |
| 重跑失败    | `tern_retry_failed`                                                                                     | `tern retry-failed <runId>`                        |

`tern_run_cases` 支持多维筛选与测试集引用：`project`（必填，或只传同项目 caseIds/suites）/ `suites[]`（引用测试集，**各用各的绑定环境**，按「用例×环境」去重执行）/ `version[]` / `module[]` / `tags[]`（`tagMode: any|all`）/ `excludeTags[]`；显式 `env` 会覆盖拉平所有测试集的环境绑定；`workerId` 缺省 = 全部空闲 worker 并行；`params` 是运行参数（注入环境变量，如 `BASE_URL`、`AUTH_ACCOUNT`）。
