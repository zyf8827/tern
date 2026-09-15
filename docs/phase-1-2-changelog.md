# Tern 开源就绪改造（阶段一与阶段二）落地总结与变更记录

本文档总结了对 Tern 代码仓库（`/workspace/tern`）实施开源就绪改造（Open Source Readiness）阶段一与阶段二的完整执行细节，包括已完成项、刻意未做项、依赖所有者授权的操作指引以及后续维护提示。

---

## 1. 阶段一完成情况：开源基础治理与深度脱敏

### 1.1 开源协议与 Monorepo 包元数据规范化

- **根许可证**：在仓库根目录添加 [LICENSE](../LICENSE)，采用标准 **Apache-2.0** 许可证（Copyright 2026 Tern Contributors）。
- **所有子包协议对齐**：为根 `package.json`、`packages/sdk`、`packages/exec-kit`、`packages/case-bundler`、`packages/cli`、`apps/server`、`apps/worker`、`apps/web`、`apps/mcp` 全部补齐 `"license": "Apache-2.0"` 与清晰的功能 `description`。
- **清理 Workspace 死路径**：从 `pnpm-workspace.yaml` 中移除已不存在的 `- cases` 目录引用。
- **根 package.json 规范**：将根包名称修正为 `"tern"`。

### 1.2 敏感信息与专有名词全量清洗

在主线业务代码、测试用例、脚本、模板与现行设计文档中全面清除了以下私有痕迹，替换为中立通用实现：

1. **专有名词「听鉴 / tingjian」**：
   - 业务文档、Web 页面注释、用例模板与示例中的 `tingjian` 全部替换为通用项目名称（如 `portal`、`demo-app`）。
2. **私有组织与域名「zeta-inc / gitlab.zeta-inc.cn」**：
   - 彻底移除了所有指向内部私有 GitLab 实例的下载链接与 Git Remote 地址，转为官方 GitHub 规范。
3. **私有内网 IP（`192.168.99.*`）**：
   - 移除 `apps/mcp/src/index.ts`、`packages/cli/src/index.ts`、`AGENTS.md`、`.env.example` 中硬编码的默认 IP `192.168.99.103:7430`，统一重构为标准本地地址 `http://127.0.0.1:7430`。
   - 移除测试和文档中出现的开发环境地址 `192.168.99.222:31008`，替换为通用示例 `127.0.0.1:3000` / `example.com`。
4. **内部接口与后门专有词「loginMock / DL-TOKEN / ResultVo」**：
   - 登录端点统一重构为通用 REST 命名：`/api/auth/mock-login`。
   - 会话 Cookie 标识统一重构为通用名称：`session_token`。
   - 响应信封说明统一抽象为通用信封结构（Result envelope：`{ success: boolean, ... }`）。
   - 同步修正了 `tests/fixtures/demo-cases-repo/` 下的合成测试用例与 `scripts/demo-site.mjs` 中的端点。

### 1.3 Git 历史全量清洗（本地已完成，未推送）

- 使用专业工具 `git-filter-repo` 对仓库全部 **37 个历史提交** 进行了深度清洗重写：
  - **提交者与作者脱敏**：将所有的内部邮箱 `zhangyunfei009@zeta-inc.com` 全量替换为公开邮箱 `Zhang Yunfei <zyf8827@gmail.com>`。
  - **Commit Message 清洗**：过滤掉了历史提交信息中出现的内网 IP（如 `192.168.99.103:7430`）及内部系统字眼。
  - **Remote 恢复**：清洗后重新将 `origin` 远端恢复绑定至 `https://github.com/zyf8827/tern.git`。

### 1.4 官方 Agent Skill 集成

- 将附件解压出的 `tern-resources` 技能规范正式拷入主仓库 [skills/tern-project/](../skills/tern-project/)：
  - `skills/tern-project/SKILL.md`
  - `skills/tern-project/references/auth-recipes.md`
  - `skills/tern-project/references/case-pitfalls.md`
  - `skills/tern-project/references/env-variables.md`
  - `skills/tern-project/references/test-suites.md`
  - `skills/tern-project/assets/`
- 对上述所有文件进行了无死角脱敏（移除私有 IP、去除内部项目特征、泛化推流音频规范与接口断言避坑模式）。

---

## 2. 阶段二完成情况：工程化、CI/CD 与开源基础设施

### 2.1 静态资源与资产发布方案（GitHub 免费闭环）

1. **MCP Standalone Bundle 重新打包**：
   - 拒绝提交已污染历史 IP 的旧 bundle 文件，基于 `apps/mcp` 纯净源码重新执行构建：产出 `dist/tern-mcp.mjs`。
   - 产物内置 `#!/usr/bin/env node` Shebang，文件权限设置为可执行（`chmod +x`），默认请求地址对齐为 `http://127.0.0.1:7430`，经 `rg` 检索敏感词命中为 0。
2. **GitHub Releases 资产自动发布工作流**：
   - 新增 [.github/workflows/release-assets.yml](../.github/workflows/release-assets.yml)：当推送版本 Tag（`v*`）时，自动编译最新代码并打包上传 `dist/tern-mcp.mjs` 到 GitHub Releases 附件中。
3. **免费资产分发三级阶梯（写入文档）**：
   - 第一优先级：`npx @tern/mcp`（npm 全球 CDN 分发）。
   - 第二优先级：GitHub Releases 页面直接下载 `tern-mcp.mjs`。
   - 第三优先级：jsDelivr / GitHub Raw 镜像下载（可选后备）。
4. **官方 Skill 安装指引落地**：
   - 编写专门的 [docs/skills.md](./skills.md)，并在 README 中明确推荐安装命令：
     ```bash
     npx skills add https://github.com/zyf8827/tern.git --skill tern-project
     ```
   - 附带针对 Claude Code、Antigravity、Cursor 的手动目录拷贝备用指引。

### 2.2 官方 MCP Registry 上架材料就绪

1. **规范注册文件**：
   - 根目录下创建标准 [server.json](../server.json)，Schema 遵循 `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`。
   - 注册命名遵循官方反向域名规范：`io.github.zyf8827/tern`。
   - `apps/mcp/package.json` 同步补充 `"mcpName": "io.github.zyf8827/tern"`，版本升级为 `0.3.0`。
2. **官方校验工具验证**：
   - 安装官方 Go 语言版本 `mcp-publisher` 二进制至系统路径。
   - 执行 `mcp-publisher validate server.json`，直接连接官方 Registry 校验通过：
     ```text
     Validating against https://registry.modelcontextprotocol.io...
     ✅ server.json is valid
     ```
3. **接入与上架文档**：
   - 撰写专门的 [docs/mcp.md](./mcp.md)，详细说明 Claude Desktop、Claude Code、Cursor、Zed 接入配置、环境变量机制及官方 Registry 发布命令清单。

### 2.3 持续集成与质量工程 (CI/CD & Lint)

1. **GitHub Actions CI**：
   - 新增 [.github/workflows/ci.yml](../.github/workflows/ci.yml)：在 push/PR 到 `main` 时执行依赖安装、`pnpm format:check`、`pnpm lint`、全量构建、单文件打包与 92 项单元测试。
   - E2E 测试作为独立 job（标记 `continue-on-error: true`），避免在无无头服务容器环境中阻塞流程。
2. **规范化代码检查与格式化**：
   - 根目录添加 [.editorconfig](../.editorconfig)、[.prettierrc](../.prettierrc)、[.prettierignore](../.prettierignore)。
   - 配置 ESLint 9/10 Flat Config [eslint.config.js](../eslint.config.js)，支持 TypeScript 与 React JSX，并兼容内联指令。
   - `pnpm lint` 跑通，0 error。

### 2.4 开源治理文件与社区建设

- [CONTRIBUTING.md](../CONTRIBUTING.md)：贡献指南、本地开发流程、PR 规范与脱敏红线。
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)：基于 Contributor Covenant 的社区行为准则。
- [SECURITY.md](../SECURITY.md)：漏洞披露流程与维护团队联系方式。
- [CHANGELOG.md](../CHANGELOG.md)：从 v0.1.0 到 v0.3.0 的语义化变更历史。
- [.github/ISSUE_TEMPLATE/bug_report.yml](../.github/ISSUE_TEMPLATE/bug_report.yml)：结构化缺陷反馈模板。
- [.github/ISSUE_TEMPLATE/feature_request.yml](../.github/ISSUE_TEMPLATE/feature_request.yml)：结构化功能提议模板。
- [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md)：包含脱敏与验证清单的 PR 模板。

### 2.5 文档体系重构与双语支持

- **架构文档演进**：将庞杂的原历史设计文档重构归档，新建现代化 [docs/architecture.md](./architecture.md)，原草稿归档为 [docs/archive/tech-design-legacy.md](./archive/tech-design-legacy.md)。
- **中英文 README**：
  - 重写 [README.md](../README.md)：加入项目 Badge、去内网、1 分钟快速上手、MCP/Skill 指引与架构图。
  - 新增全英文对照 [README_en.md](../README_en.md)，支持顶栏双向语言跳转。

### 2.6 环境与通知解耦

- **Docker 官方源默认**：
  - `docker/server.Dockerfile` 与 `docker/worker.Dockerfile` 默认上游源（`https://registry.npmjs.org`），中国源转为可选的 build-arg。
  - `scripts/init-compose.sh`、`scripts/dev.sh`、`scripts/docker-build.sh` 同步去写死。
- **通用 Webhook 通知系统**：
  - 重构 `apps/server/src/notifier.ts` 为通用 Webhook（Generic Webhook），支持向任意 HTTP 接收端推送带有 `X-Tern-Signature`（HMAC-SHA256）的结构化 JSON 报警与完成摘要；
  - 钉钉机器人转为可选 provider，彻底解除写死绑定。

---

## 3. 刻意未做项与设计边界（Deliberate Non-Actions）

为恪守工程安全底线与用户的明确授权要求，以下操作**严格由本地执行，绝未向公网触发**：

1. **未执行 `git push` 或 `git push --force`**：
   - 本地 Git 历史已被 `git-filter-repo` 重写，所有 commit 的哈希均已发生变化。
   - 按照开源协作规范，必须由拥有仓库写权限的用户在确认本地提交无误后，手动执行 Force-Push。
2. **未执行 `npm publish`**：
   - `@tern/mcp` 与其他包已做好发布准备（`publishConfig`、`bin`、`mcpName` 均配置妥当），但未向 npm 官方公共仓库发布任何包。
3. **未向 MCP Registry 发起交互式授权与发布**：
   - 真实发布需要 GitHub OAuth 交互认证；我们完成了 `server.json` 生成与 `mcp-publisher validate` 本地实测，未伪造或强行发布。

---

## 4. 后续需用户亲自操作的授权发布步骤清单

在将改动推向公网前，请按以下步骤依次操作：

### 步骤 1：Force-push 本地已清洗历史到 GitHub 远程仓库

由于提交历史已被全面脱敏重写，直接 push 会被拒绝，必须执行 force-push：

```bash
cd /workspace/tern

# 检查当前提交历史与远程地址
git log -n 5 --oneline
git remote -v

# 确认无误后强制更新远端（需要 GitHub 登录凭据）
git push origin main --force
```

> **注意**：如果团队有其他协作者克隆过旧历史，请提醒他们重新 `git clone` 或 `git reset --hard origin/main`。

---

### 步骤 2：发布 `@tern/mcp` 到 npm

如果需要支持全球用户直接通过 `npx -y @tern/mcp` 运行：

```bash
cd /workspace/tern/apps/mcp

# 1. 登录 npm 官方账号
npm login

# 2. 发布（公开发布需 public access）
npm publish --access public
```

_(若打算发布为无作用域的包名，可在 `apps/mcp/package.json` 中更名为 `tern-mcp` 后再执行 publish)_

---

### 步骤 3：发布到官方 MCP Registry

在已安装的官方 `mcp-publisher` 工具下进行授权发布：

```bash
cd /workspace/tern

# 1. 登录 GitHub 账号（工具会提示在浏览器打开链接并输入一次性设备码）
mcp-publisher login github

# 2. 再次校验规范描述文件
mcp-publisher validate server.json

# 3. 正式发布到 MCP Registry
mcp-publisher publish server.json
```

发布后，全球支持 MCP 的客户端即能够检索并解析 `io.github.zyf8827/tern`。

---

### 步骤 4：创建 Release 触发静态产物自动构建与分发

当准备发布正式开源版本时，推送 Git Tag：

```bash
cd /workspace/tern

# 创建 v0.3.0 tag 并推送到 GitHub
git tag v0.3.0
git push origin v0.3.0
```

GitHub Actions 中的 `release-assets.yml` 工作流将自动被触发，并将最新打包的 `tern-mcp.mjs` 自动上传至对应 Release 附件中。
