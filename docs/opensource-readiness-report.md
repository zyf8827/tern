# Tern（北极燕鸥）开源就绪度评估与改造建议报告
> Open Source Readiness & Gap Analysis Report for Tern Platform

---

## 1. 执行摘要

经过对 Tern（北极燕鸥）仓库的代码架构、依赖生态、Docker 编排、配置脚本、文档体系、测试套件及 Git 提交历史的全面评估，核心结论如下：

1. **业务架构与产品创新度极高，具备成为头部开源项目的潜质**：Tern 抓住了「用例由 Coding Agent 编写与自愈」这一极具前瞻性的切入点，通过「用例放 Git 仓库、零代码平台只读拉取、Playwright 原生 + Frontmatter、会话声明式注入、MCP 27 工具闭环、多集多环境去重」等机制，构建了极其闭环且轻量的测试平台。整体代码整洁度与技术实现质量上乘。
2. **存在阻断级合规与敏感信息泄漏（P0 阻断项）**：
   - 仓库完全**缺失开源许可证（LICENSE 文件及 package.json license 字段均为空）**，法律层面禁止任何人分发与使用；
   - 硬编码了企业内网 IP（如 `192.168.99.103`、`192.168.99.222`）于 CLI 默认配置、MCP 入口、README、`.env.example` 及测试用例中；
   - 核心工作流强依赖公司内网私有 GitLab（`gitlab.zeta-inc.cn` 上的 `tern-resources`），外部用户无法拉取 Agent Skill 与 MCP bundle；
   - 历史 Git 提交记录（共 37 条 commit）全部携带公司内部邮箱（`@zeta-inc.com`），并残留多处内网调试 commit。
3. **残留深度绑定的内部业务资产与专有名词（P0/P1）**：核心文档（如 `auth-design.md`、`test-assets-design.md`）和部分业务代码（如 `apps/web/src/SuitesPage.tsx`、`packages/exec-kit/src/auth.ts`）直接耦合了内部项目「听鉴（tingjian）」、其开发后门登录逻辑（`loginMock`、`ResultVo`、`DL-TOKEN`）与业务数据流，未完成通用化抽象。
4. **工程化与质量门槛显著缺失（P1 改进项）**：完全**缺失 CI/CD 流水线**（无 `.github/workflows`）；根项目命名仍为旧代号 `e2e-platform`；未配置 ESLint / Prettier 等静态分析与代码风格约束；前端 `apps/web` 与叶子包 `@tern/sdk`、`@tern/cli`、`@tern/mcp` 缺少单元测试；单测依赖编译后产物导致开发体验断层。
5. **生态与海外可访问性受限（P1 改进项）**：Docker 构建及初始化脚本全面硬编码中国镜像源（阿里云 apt、npmmirror），海外开发者构建速度极慢甚至失败；通知系统硬编码为钉钉（DingTalk），缺少国际通用的 Webhook、Slack、Discord 支持。
6. **开源治理文档全面空白（P1 阻断项）**：缺失 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md` 及 GitHub Issue/PR 模板，社区贡献与安全漏洞披露通道未建立。

---

## 2. 当前成熟度速览

| 评估维度 | 现状描述 | 评级 (高/中/低) |
| :--- | :--- | :---: |
| **开源法律与合规** | 缺少根目录 LICENSE 文件；所有 `package.json` 均无 `license` 声明；Git 提交者全部为公司内网邮箱（`@zeta-inc.com`）。 | **低（阻断）** |
| **敏感信息与去内部化** | 存在多处硬编码内网 IP（`192.168.99.103` 等）、内网 GitLab 私有链接（`gitlab.zeta-inc.cn`）、内部项目代号（`tingjian` / 听鉴）、内部工具名（`ZCode`）。 | **低（阻断）** |
| **架构与功能完成度** | Fastify + SQLite 单文件无外置中间件；MCP 27 工具覆盖全生命周期；原生 Playwright + esbuild 隔离执行；设备反代解决安全上下文；架构极其精炼。 | **高** |
| **安全性与权限模型** | 默认无鉴权（`API_TOKEN` 缺省为空）；配置时仅防范写操作，GET 读接口全量裸奔；Worker 信任边界依赖单 Token；无多租户与 RBAC。 | **中** |
| **CI/CD 与工程化** | 无任何 CI 配置文件（缺少 GitHub Actions / GitLab CI）；无代码格式化（Prettier）与 Linter（ESLint）；根包名为 `e2e-platform`。 | **低** |
| **测试与质量保障** | 具备高质量的端到端测试（`scripts/e2e-test.mjs`，1077行）及核心后端单测；但 Web 端与 SDK/CLI/MCP 无单测；单测依赖构建产物。 | **中** |
| **开发者体验 (DX)** | 提供 `scripts/init-compose.sh` 交互配置与本地 `demo-site.mjs` 演示；但海外源不可用；CLI 默认连内网 IP；`pnpm-workspace.yaml` 存在无效路径。 | **中** |
| **文档完备性** | 技术设计文档极其丰富（架构、认证、资产、设备反代、测试集均有详尽方案），但混杂历史废弃方案与内部业务专有细节，缺少双语支持。 | **中** |
| **社区与开源治理** | 缺失 CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、CHANGELOG、Issue/PR 模板及 NPM 发布流水线。 | **低** |

---

## 3. 必须修改才能开源（阻断项）

本章节列出项目公开发布前**必须完成改造的硬性阻断项**。按优先级分为 **P0（法律合规/私有依赖/泄漏）** 与 **P1（核心可用性/基础治理）**。

### 3.1 P0 优先级（法律风险、机密泄露与不可达依赖）

#### 1. 缺失开源许可证（License Compliance）
- **问题描述**：仓库根目录无任何 `LICENSE` / `LICENSE.md` / `COPYING` 文件，且所有 `package.json`（根与 8 个子项目）均未声明 `"license"`。根据国际版权法，未授权代码受严格版权保护，公众无权克隆、分发、修改或商用。
- **涉及路径**：
  - `/workspace/tern/package.json`
  - `/workspace/tern/packages/*/package.json` (cli, sdk, exec-kit, case-bundler)
  - `/workspace/tern/apps/*/package.json` (server, worker, web, mcp)
- **修复方案**：
  1. 根目录补充 `LICENSE` 文件，推荐采用商用友好的 **Apache License 2.0**（具备明确的专利授权与商标限制条款）或 **MIT License**；
  2. 在所有 `package.json` 中添加 `"license": "Apache-2.0"`。

#### 2. 硬编码内网 IP 地址与生产/测试环境服务器信息
- **问题描述**：代码与文档中将研发团队的测试主机（`192.168.99.103:7430`）以及内部被测系统（`192.168.99.222:31008`）作为默认地址固化在源码、模板和文档中。一旦开源，会导致外部用户的 CLI/MCP 默认连向内网死地址，且泄漏了企业内部网络拓扑。
- **涉及路径与具体内容**：
  - `README.md`（第 75, 81, 111, 113, 115, 116 行）：硬编码 `http://192.168.99.103:7430` 与被测地址 `http://192.168.99.222:31008`；
  - `.env.example`（第 13 行）：`PUBLIC_URL=http://192.168.99.103:7430`；
  - `packages/cli/src/index.ts`（第 67, 75 行）：`baseUrl: process.env.TERN_URL ?? 'http://192.168.99.103:7430'`；
  - `apps/mcp/src/index.ts`（第 9 行）：`const baseUrl = process.env.TERN_URL ?? 'http://192.168.99.103:7430'`；
  - `scripts/bundle-mcp.mjs`：打包生成 bundle 时直接把内网回退地址打进单文件；
  - `packages/exec-kit/src/runner.test.ts`（第 6, 16, 17 行）与 `apps/worker/src/device-proxy.test.ts`（第 8, 12 行）：包含 `http://192.168.99.222:31008`。
- **修复方案**：
  1. CLI 与 MCP 的 `baseUrl` 回退值改为 `http://127.0.0.1:7430`，或当 `TERN_URL` 未配置且无法连通时输出明确提示；
  2. `.env.example` 中改为 `PUBLIC_URL=http://localhost:7430`；
  3. README 中移除「团队使用环境（已部署实例）」整个内网章节；
  4. 测试用例中的 IP 统一换成 RFC 5737 规定的测试 IP（如 `192.0.2.1`、`203.0.113.1`）或 `example.com` / `127.0.0.1`。

#### 3. 依赖私有 GitLab 仓库导致核心链路断死
- **问题描述**：README 中将「安装 Agent Skill」和「获取 MCP 单文件 Bundle」作为新手入门第 ② 步和核心入口，但其引用的下载链接全部指向企业内部私有 GitLab：`https://gitlab.zeta-inc.cn/zhangyunfei009/tern-resources`。公网用户无法访问该域名，导致项目核心功能对外部用户完全不可用。
- **涉及路径**：
  - `README.md`（第 48, 51, 62, 65, 66 行）
  - `.gitignore`（第 21 行：`tern-resources/`）
  - `.dockerignore`（第 11 行：`tern-resources/`）
  - `docs/test-suite-design.md`（第 481 行）
- **修复方案**：
  - **方案 A（强烈推荐，Monorepo 整合）**：将 `tern-resources` 仓库中的 Skill（`tern-project`）及 bundle 脚本作为当前 Monorepo 的一部分（如放在 `skills/tern-project` 或 `apps/mcp`），随主仓库公开发布，并通过标准 npm 包分发 MCP（例如 `npx @tern/mcp`）；
  - **方案 B（双仓库开源）**：同步将 `tern-resources` 迁移至公共 GitHub 组织，并将文档中的所有链接替换为公网 GitHub 链接与 Releases 下载链接。

#### 4. Git Commit 历史中的内部身份与敏感痕迹
- **问题描述**：当前仓库共 37 次 commit，全部提交者为 `Zhang Yunfei <zhangyunfei009@zeta-inc.com>`，泄漏了内部企业员工邮箱与公司域名 `zeta-inc.com`。同时部分提交信息直接记录了内网 IP 变更（如 commit `e8887af`、`d3dc981`、`3515668`）。
- **涉及路径**：
  - `.git/` 提交历史
- **修复方案**：
  - **方案 A（保留提交历史）**：使用 `git-filter-repo` 对历史 commit 的 author/committer 邮箱与提交信息进行脱敏重写（例如替换为 GitHub noreply 邮箱），清洗包含内网 IP 的提交记录；
  - **方案 B（全新首发提交）**：在确认开源准备就绪后，基于当前干净的 working tree 重新执行 `git init`，创建统一的 initial commit 发布。

---

### 3.2 P1 优先级（内部专有名词清理与核心安全防护）

#### 1. 深度绑定的内部业务专有名词「听鉴（tingjian）」
- **问题描述**：「听鉴（tingjian）」是公司内部具体的业务前端系统（涉及法律文书、笔录音频采集、ASR 语音转写等）。在平台代码的认证逻辑、错误解析、测试用例、组件代码及文档中，散落着针对「听鉴」特异逻辑的硬编码（如 `loginMock`、`ResultVo`、`DL-TOKEN`、`tern-project-tingjian`）。
- **涉及路径与具体内容**：
  - `packages/sdk/src/types.ts`（第 32 行）：注释写有「如 success，听鉴 ResultVo」；
  - `packages/exec-kit/src/auth.ts`（第 140 行、302 行）：`function bizFailInfo`:「从听鉴式 ResultVo（{success, code, msg}）里取业务失败信息」；
  - `apps/web/src/SuitesPage.tsx`（第 49 行）：`// 未选项目且只有一个项目时自动选中（如当前实例仅接入 tingjian）`；
  - `scripts/demo-site.mjs`（第 3, 80, 124, 179 行）：`同时模拟听鉴开发后门`、`录音页（模拟听鉴采集）`、`听鉴语义：业务页面/接口由 DL-TOKEN 还原登录态`；
  - `tests/fixtures/demo-cases-repo/tern.yaml`（第 24, 35 行）：`# 听鉴开发后门：GET /api/auth/loginMock...`；
  - `docs/tech-design.md`（第 7 行）：`| 代码库 | tingjian/tern |`；
  - `docs/auth-design.md`（第 20, 54, 56, 108 等多处）：全文以「听鉴开发后门」为主案例；
  - `docs/test-assets-design.md`（第 1, 5, 7, 105, 124 行）：详细披露了听鉴业务链路协议（`opCode: start / send / opt_fulltext` 等被测系统私有协议）；
  - `README.md`（第 13 行）：提及内部 Agent 工具 `ZCode`。
- **修复方案**：
  1. 将业务特异性逻辑抽象为通用协议：`ResultVo` 抽象为通用「REST Response Envelope（如 `{ code, message, data }`）」；`loginMock` 抽象为「Mock Dev Auth / Token Bypass」；
  2. 移除代码注释与前端组件中的 `tingjian` / `ZCode` 字样；
  3. 重构设计文档，将内部协议细节与专用业务方案剥离，转为通用的「音频推流与设备测试用例指南」。

#### 2. 安全与鉴权设计局限性
- **问题描述**：
  - **默认无鉴权**：`apps/server/src/api.ts` 中 `checkApiAuth` 仅在环境变量显式配置 `API_TOKEN` 时才校验，未配置时完全放行；
  - **只鉴权写操作，读接口完全暴露**：`checkApiAuth` 仅注入在 `POST/PATCH/DELETE` 路由，所有 `GET` 路由均无任何权限验证。若服务部署在公网或不对等网络，未授权第三方可任意读取项目代码结构、用例名、历史执行结果、控制台日志、失败截图、测试用例敏感标签，甚至读取 Webhook 配置；
  - **`file://` 协议本地代码添加**：`apps/server/src/git.ts` 与 `repos.ts` 允许添加 `file://` 或本地绝对路径作为 project。在多用户开源使用场景下，恶意用户可通过添加项目访问服务器文件系统。
- **修复方案**：
  1. 在部署文档与日志中输出强警告，禁止未设 `API_TOKEN` 的实例对外开放网络；
  2. 增加全局鉴权中间件选项（例如 `AUTH_ENFORCE_READ=true`），允许用户配置全站 Bearer Token 鉴权；
  3. 对 `file://` 本地仓库添加功能增加环境控制开关（如仅在 `LOCAL_MODE=true` 时开启），默认在标准容器部署中禁用。

---

## 4. 强烈建议改进（工程化、质量、DX 与可贡献性）

本章节针对开源项目质量、社区协作门槛及开发者体验提出改进项。

### 4.1 工程化与代码规范

1. **统一 Monorepo 命名与包元数据**：
   - 根目录 `package.json` 的 `"name": "e2e-platform"` 需变更为 `"name": "tern"` 或 `"name": "@tern/monorepo"`；
   - 补齐所有包的元数据：`repository`、`homepage`、`bugs`、`author`、`keywords`；
   - 公开包（`@tern/cli`、`@tern/sdk`、`@tern/mcp`）补充 `"publishConfig": { "access": "public" }` 与 `"files": ["dist"]`。
2. **修复 `pnpm-workspace.yaml` 中的死路径**：
   - 当前配置中包含 `cases`，但仓库根本不存在 `cases/` 目录（用例由独立仓库或 `tests/fixtures` 提供）。应移除该项，避免 pnpm 解析警告。
3. **引入代码格式化与规范工具（Linting & Formatting）**：
   - 仓库目前**没有任何 ESLint、Prettier、EditorConfig 配置文件**；
   - 强烈建议在根目录引入：
     - `.editorconfig`（统一跨编辑器缩进、换行、编码）；
     - `prettier`（统一代码风格）；
     - `eslint` + `@typescript-eslint`；
     - `husky` + `lint-staged`（Git commit 前自动格式化与语法校验）。
4. **单元测试直接运行与执行体验优化**：
   - 当前根脚本 `"test:unit"` 为 `node --test packages/case-bundler/dist/*.test.js ...`，**必须在 `pnpm build` 后才能执行**。若开发者修改源码后直接跑 `pnpm test`，运行的是过时的编译代码；
   - 建议引入基于 TypeScript 直接执行的测试方案（例如在 `test:unit` 中使用 `tsx --test` 或统一接入 `vitest`），免除手动 pre-build 负担。

### 4.2 质量与测试覆盖率补齐

1. **缺失 GitHub Actions CI 流水线**：
   - 目前 PR 无法进行自动化门禁检查。需创建 `.github/workflows/ci.yml`，包含以下 jobs：
     - `lint-and-typecheck`: `pnpm -r exec tsc --noEmit` + lint；
     - `unit-tests`: 运行各包单元测试；
     - `docker-build`: 验证两镜像的多阶段构建是否正常；
     - `e2e-test`: 在 Ubuntu 虚拟机中无头拉起 demo 服务并执行 `scripts/e2e-test.mjs`。
2. **前端 Web 与客户端 SDK 缺少测试**：
   - `apps/web`（React + Vite）无任何组件测试或集成测试，重构页面极易出现回归缺陷；
   - `@tern/sdk`、`@tern/cli`、`@tern/mcp` 缺少独立的单元测试（目前完全靠 `scripts/e2e-test.mjs` 黑盒驱动）。应补充参数序列化、错误处理及 schema 验证的独立单测。

### 4.3 国际化与开发者体验（DX）

1. **解耦中国特化源配置（Apt & NPM & Playwright）**：
   - Dockerfile 与 `scripts/dev.sh` 默认写死了 `mirrors.aliyun.com`、`registry.npmmirror.com`、`https://npmmirror.com/mirrors/playwright`；
   - **开源改造**：Dockerfile 中的 `ARG APT_MIRROR`、`ARG NPM_REGISTRY` 默认值应置为空或官方官方源，在 `docker-compose.example.yml` 和 `scripts/init-compose.sh` 中提供「境内加速网络选项」，而不是默认硬编码中国源。
2. **通知渠道多样化**：
   - 当前系统的 `webhooks` 表和 `notifier.ts` **写死了 `type: 'dingtalk'`（钉钉机器人）**；
   - 国际主流开源社区使用 **Slack、Discord、Telegram、Lark/飞书、企业微信** 以及通用 **Custom Webhook**（标准 JSON payload）。应将通知器重构为 Provider 插件模式，至少原生支持 Generic Webhook 与 Slack。

---

## 5. 文档与 README 优化清单

对仓库内现有所有文档给出评估结论（**保留微调 / 大改 / 重写 / 新建**），逐项说明存在的问题、修改建议及目标读者。

| 文件路径 | 评估结论 | 主要问题 | 修改建议 | 目标读者 |
| :--- | :---: | :--- | :--- | :--- |
| `README.md` | **大改** | 1. 包含内网 IP（`192.168.99.103`）与私有 GitLab 地址；<br>2. 混入团队内部已部署实例；<br>3. 包含内部项目名 `tingjian` 与 Agent 代号 `ZCode`；<br>4. 缺少开源徽章、CI 状态、多语言切换。 | 1. 彻底删除「团队使用环境」一节；<br>2. 安装与 MCP 单文件链接改为公共 GitHub Releases 或 NPM 安装方式；<br>3. 增加架构拓扑图、快速 1 分钟 Docker 启动引导；<br>4. 增加中英文切换。 | 外部使用者、开源评估者、终端开发者 |
| `AGENTS.md` | **保留微调** | 1. Web 入口说明中含有内网 IP；<br>2. 认证示例与错误码包含「听鉴 ResultVo」等专有名词。 | 1. 将内网 IP 替换为变量占位符；<br>2. 将「听鉴」改为通用业务案例（如 `demo-portal`）；<br>3. 保留其余核心规范（该规范结构清晰，对 Coding Agent 极度友好，是核心亮点）。 | Coding Agent（Claude Code/Cursor 等）、用例编写者 |
| `docs/deploy.md` | **保留微调** | 1. 默认网络源为中国镜像；<br>2. 缺少公网部署（反向代理 Nginx/TLS 证书/域名访问）指导。 | 1. 明确镜像源覆盖参数说明；<br>2. 补充 Nginx / Caddy 反代配置示例与 HTTPS 接入最佳实践；<br>3. 强调公网安全防护（API_TOKEN 与网络隔离）。 | 运维工程师、自建私有化部署者 |
| `docs/tech-design.md` | **重写/归档重构** | 1. 头部注明为 `tingjian/tern`；<br>2. 篇幅过大（72KB），混杂了已废弃的历史方案与过渡设计（如已被 `auth-design` 替换的老章节）；<br>3. 部分内网 IP 与废弃路由残留。 | 1. 剥离历史讨论，重写为权威的系统架构白皮书 `docs/architecture.md`；<br>2. 历史提案移至 `docs/rfcs/` 目录归档；<br>3. 清理内部项目名与内网地址。 | 核心贡献者、架构师、深度二开人员 |
| `docs/auth-design.md` | **大改** | 1. 全文以「听鉴开发后门」为核心背景设计展开，夹杂内部 IP `192.168.99.222` 与业务名；<br>2. 缺乏通用企业级 SSO / OAuth / Token 认证场景的标准示范。 | 1. 将「听鉴开发后门」重命名为「通用接口模拟登录（API Mock Auth）」；<br>2. 将示例中的私有域名与 IP 替换为标准示例；<br>3. 抽象三类认证模式（表单/接口/直写）的通用最佳实践。 | 测试开发工程师、Agent 提示词设计者 |
| `docs/test-assets-design.md` | **大改** | 1. 包含听鉴业务链路事实核对及专有二进制 WebSocket 协议解析（ASR、笔录等），属于企业专有业务，不应开源。 | 1. 剥离听鉴专有业务协议细节；<br>2. 提炼为通用的「测试文件资产管理与流媒体/硬件设备模拟方案」；<br>3. 保留 fake 麦克风 PCM 推流与资产内容寻址的核心设计。 | 复杂媒体/音视频 E2E 测试工程师 |
| `docs/device-proxy-design.md` | **保留微调** | 1. 提及 `tern-project-tingjian` 实测数据及内网 IP。 | 1. 脱敏测试数据中的业务仓库名称与内网 IP；<br>2. 保留对 Chromium secure context 机制的分析与反代技术实现（技术含金量极高，是不可多得的优秀方案）。 | 遇到不可信网络下设备权限问题的开发者 |
| `docs/test-suite-design.md` | **保留微调** | 1. 案例以听鉴业务系统举例。 | 1. 将示例项目名 `tingjian` 改为通用的 `portal` 或 `crm`；<br>2. 保留多环境测试集去重合并的完整设计与推导。 | 测试主管、测试集设计者 |
| `docs/platform-enhancements.md` | **归档重组** | 1. 状态仍标为「设计稿（待评审）」，但实际各功能已全量代码落地；<br>2. 作为设计稿已完成历史使命。 | 1. 状态更新为「已实现（v0.6 归档）」；<br>2. 移入 `docs/rfcs/0001-platform-enhancements.md`。 | 平台设计研究者、版本演进追踪者 |
| *(新建)* `CONTRIBUTING.md` | **新建** | 缺失。外部贡献者不知道如何参与、如何本地调试、如何跑单测、PR 规则。 | 编写标准贡献指南：环境要求（Node 20+、pnpm 10+）、分支管理、代码规范、测试执行、PR 提交规范。 | 开源社区贡献者 |
| *(新建)* `CODE_OF_CONDUCT.md` | **新建** | 缺失社区行为准则。 | 引入国际通用的 Contributor Covenant v2.1 准则。 | 社区成员与维护者 |
| *(新建)* `SECURITY.md` | **新建** | 缺失安全漏洞披露策略。 | 明确指出漏洞报告流程（通过 GitHub Security Advisories 或安全邮箱接收，不走公开 Issue）。 | 安全研究员、合规审查人员 |
| *(新建)* `CHANGELOG.md` | **新建** | 缺失版本演进记录。 | 依据历史 commit 与里程碑梳理从 v0.1 到 v0.6 的标准化语义化变更日志（Keep a Changelog 格式）。 | 平台用户与升级维护者 |

---

## 6. 社区与治理体系建议

要成为受开源社区信赖的成熟项目，必须建立完备的治理与自动化支撑体系：

### 6.1 许可证与版权策略（License & Copyright）
- **推荐协议**：**Apache License 2.0**
  - *考量*：Tern 属于平台级系统，包含 Server、Worker、CLI、SDK 和 MCP，Apache-2.0 不仅允许商业闭源使用（利于企业采纳），更具备专利授权条款和明确的商标保护机制，能有效防止分叉侵权。
- **版权归属声明**：
  - 在 `LICENSE` 头部注明 `Copyright (c) 2026 Tern Contributors`（或公司官方开源实体名称）。

### 6.2 社区互动与模板规范（GitHub Templates）
在 `.github/` 目录下建立标准化互动规范：
1. **`.github/ISSUE_TEMPLATE/`**：
   - `bug_report.yml`：环境版本（Node/Docker/OS）、Playwright 版本、复现步骤、Worker 日志截图；
   - `feature_request.yml`：痛点场景、建议方案、替代考量；
   - `config.yml`：引导用户先查阅文档或进入 Discussions 讨论。
2. **`.github/PULL_REQUEST_TEMPLATE.md`**：
   - 改动类型（Bugfix, Feat, Refactor, Docs）；
   - 关联 Issue 编号；
   - 勾选项检查清单：是否包含单元测试、文档是否同步更新、本地 `pnpm test` 是否全部通过。

### 6.3 安全漏洞披露规范（SECURITY.md）
- 建立安全响应机制，明确保密披露邮箱或启用 GitHub Private Vulnerability Reporting；
- 列出受支持的版本矩阵（如仅支持最新的 `v0.x` 版本）；
- 承诺响应 SLA（如 48 小时内确认漏洞有效性，7 天内提供修复补丁）。

### 6.4 发版与包分发机制（Release & Publishing）
- **NPM 发包规划**：
  - 核心独立包需公开发布至 npm 官方注册表：
    - `@tern/sdk`：供第三方开发者集成 API；
    - `@tern/cli`：终端命令行工具（全局安装或 npx）；
    - `@tern/mcp`：供 Coding Agent 使用的标准 MCP server；
  - 推荐引入 **Changesets**（`@changesets/cli`）管理 Monorepo 的版本递增与发包日志。
- **容器镜像发布**：
  - 配置 GitHub Actions 工作流，在推 tag 时自动构建并推送多架构镜像（`linux/amd64`, `linux/arm64`）至 **GitHub Container Registry (ghcr.io)** 与 **Docker Hub**；
  - 彻底免去用户本地必须 `docker compose build` 的漫长等待，支持 `docker pull ghcr.io/xxx/tern-server:latest` 直接拉取开箱即用。

---

## 7. 建议落地路线图

建议分为三个阶段推进开源准备：

```mermaid
flowchart LR
    A["第一阶段：合规与去敏感化<br/>（第 1–2 周，阻断项清除）"] --> B["第二阶段：工程基建与治理<br/>（第 1–2 月，开源可用发布）"]
    B --> C["第三阶段：生态扩展与社区化<br/>（长期 3–6 月，影响力建设）"]
```

### 阶段一：合规与去敏感化（第 1–2 周 · 阻断项清除）
*目标：排除所有法律风险与企业信息泄露，让仓库具备合法公开资格。*
- [ ] **添加 LICENSE**：根目录添加 Apache-2.0 许可证，所有 `package.json` 添加 `license` 字段；
- [ ] **移除内网 IP 与私有地址**：
  - 清理 `README.md`、`.env.example`、`packages/cli/src/index.ts`、`apps/mcp/src/index.ts` 中的 `192.168.99.103`；
  - 清除测试代码中的 `192.168.99.222`；
- [ ] **解耦私有 GitLab 依赖**：
  - 将 `tern-resources` 中的 skill 整合入主仓库或在 GitHub 建立公开发布；
  - README 指向标准 public 链接；
- [ ] **清理专有名词「听鉴」与内部逻辑**：
  - 替换代码注释、前端提示、测试用例和文档中的 `tingjian`、`loginMock` 等内部业务专有名称；
  - 调整 `docs/auth-design.md` 与 `docs/test-assets-design.md`；
- [ ] **Git 历史清洗**：
  - 使用 `git-filter-repo` 脱敏提交者邮箱 `@zeta-inc.com`，清洗包含内网 IP 的 commit 信息；
- [ ] **修正工程配置**：
  - 将根 `package.json` 名称改为 `tern`；
  - 清理 `pnpm-workspace.yaml` 中不存在的 `cases` 目录。

### 阶段二：工程基建与治理体系（第 1–2 个月 · 正式公开发布）
*目标：建立 CI/CD、代码规范与完备文档，达到成熟开源项目的可用标准。*
- [ ] **搭建 CI 流水线**：
  - 新建 `.github/workflows/ci.yml`，对 PR 和 push 自动执行构建、lint、类型检查与端到端测试；
- [ ] **代码质量工具链**：
  - 配置 Prettier、ESLint、EditorConfig、Husky 与 lint-staged；
  - 重构 `test:unit` 脚本，支持直接运行 TypeScript 测试，解除必须 pre-build 的限制；
- [ ] **完善社区与治理文件**：
  - 新建 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`；
  - 新建 Issue 模板与 PR 模板；
- [ ] **文档重构与国际化**：
  - README 增加架构图、精简快速入门，增加英文版 `README.md`（中文保留为 `README_zh.md` 或同等权重）；
  - 重构 `docs/tech-design.md` 为 `docs/architecture.md`，归档历史设计草案；
- [ ] **Docker 与多环境支持**：
  - 将 Dockerfile 与脚本的默认源恢复为官方上游，中国镜像转为可选配置参数；
  - 构建多架构镜像并发布到 GHCR；
- [ ] **通知生态扩展**：
  - 抽象 Webhook 发送器，补充通用 HTTP Webhook 与 Slack 支持。

### 阶段三：生态扩展与社区化建设（长期 3–6 个月 · 标杆打造）
*目标：拓展 Agent 生态互联互通，打造开源 AI 测试平台标杆。*
- [ ] **Agent 开放生态集成**：
  - 注册并上架至 Model Context Protocol (MCP) 官方/社区 Registry；
  - 提供针对 Claude Code、Cursor、Windsurf、OpenAI Operator 的一键适配文档与插件；
- [ ] **企业级多租户与鉴权增强**：
  - 实现基于 JWT / API Key 的细粒度权限管控（区分只读用户、测试执行者、管理员）；
  - 全局只读接口鉴权覆盖；
- [ ] **大规模 Worker 调度与编排**：
  - 提供 Kubernetes Helm Chart 部署清单；
  - 支持按需动态拉起/销毁 Ephemeral Worker 容器；
- [ ] **测试覆盖率全面跃升**：
  - 为 `apps/web` 补充基于 Playwright Component Testing / Vitest 的前端自动化测试；
  - 为 `@tern/sdk` 与 `@tern/cli` 编写独立集成单测。

---

## 8. 附录：已检查的关键路径清单

本报告基于对仓库内以下关键文件与目录的实际源码核查生成：

1. **根目录与工程配置**：
   - `package.json`（检查包名、版本、脚本、依赖）
   - `pnpm-workspace.yaml`（检查 workspace 目录映射有效性）
   - `pnpm-lock.yaml`（检查依赖源与包完整性）
   - `tsconfig.base.json`（检查 TypeScript 基础编译规则）
   - `.gitignore` 与 `.dockerignore`（检查忽略项与内部仓库引用）
   - `.env.example`（检查默认环境变量与硬编码 IP）
   - `docker-compose.example.yml`（检查容器编排、挂载点与权限安全配置）
   - `README.md` 与 `AGENTS.md`（检查产品定位、上手指南与内部专有信息）
2. **应用服务（apps/）**：
   - `apps/server/src/`：
     - `api.ts`（检查 REST 路由鉴权机制、公开接口暴露范围与 Webhook 处理）
     - `runtime.ts`（检查核心调度状态机、租约与生命周期）
     - `git.ts`（检查 Git 操作隔离、凭证保护机制与本地协议安全）
     - `repos.ts`（检查仓库克隆与同步逻辑）
     - `notifier.ts`（检查通知发送逻辑与钉钉耦合度）
     - `crypto.ts`（检查凭据加密机制与测试用例敏感信息）
     - `envs.ts`、`suites.ts`、`migrations.ts`（检查环境加密存储与测试集去重逻辑）
   - `apps/worker/src/`：
     - `index.ts`（检查 Worker 连接与执行调度机制）
     - `device-proxy.ts` 与 `device-proxy.test.ts`（检查设备反向代理实现与 IP 断言）
   - `apps/web/src/`：
     - `App.tsx`、`ProjectsPage.tsx`、`RunsPage.tsx`、`SuitesPage.tsx`（检查前端路由与内部默认值）
     - `ProjectConfigDialog.tsx`（检查 Webhook 与环境配置交互）
   - `apps/mcp/src/`：
     - `index.ts`（检查 MCP 工具注册、连接默认值与数据脱敏）
3. **共享包（packages/）**：
   - `packages/sdk/src/`（`client.ts`, `types.ts`，检查类型定义与业务耦合字段）
   - `packages/cli/src/`（`index.ts`，检查命令行工具与默认连接配置）
   - `packages/exec-kit/src/`（`auth.ts`, `runner.ts`, `screencast.ts`，检查执行层认证逻辑与测试用例 IP）
   - `packages/case-bundler/src/`（`frontmatter.ts`, `bundle.ts`, `lint.ts`，检查用例打包与语法校验）
4. **容器与脚本（docker/ & scripts/）**：
   - `docker/server.Dockerfile` 与 `docker/worker.Dockerfile`（检查基础镜像、多阶段构建与网络源）
   - `scripts/init-compose.sh`（检查初始化引导脚本与 IP 探测）
   - `scripts/bundle-mcp.mjs`（检查 MCP 打包脚本与产物单文件生成）
   - `scripts/demo-site.mjs`（检查本地测试站点与内部场景模拟）
   - `scripts/dev.sh`、`scripts/docker-build.sh`、`scripts/docker-smoke.sh`（检查辅助运维工具链）
   - `scripts/e2e-test.mjs`（检查端到端综合测试覆盖面）
5. **文档与演示（docs/ & tests/）**：
   - `docs/tech-design.md`、`docs/auth-design.md`、`docs/test-assets-design.md`、`docs/device-proxy-design.md`、`docs/test-suite-design.md`、`docs/platform-enhancements.md`、`docs/deploy.md`
   - `tests/fixtures/demo-cases-repo/`（检查随库演示仓库定义与配置示范）
