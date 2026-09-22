# 变更日志 (Changelog)

本项目遵循 [Semantic Versioning 2.0.0](https://semver.org/lang/zh-CN/) 语义化版本规范。

---

## [0.3.0] - 2026-09-22

### 重大变更与开源就绪改造 (Open Source Readiness)

- **协议与开源治理**：
  - 确立根开源许可证为 Apache-2.0，所有子包与应用同步更新。
  - 建立开源贡献指南 `CONTRIBUTING.md`、行为准则 `CODE_OF_CONDUCT.md`、安全策略 `SECURITY.md` 与 Issue/PR 规范模板。
  - Git 历史全量清洗脱敏，更新作者与提交邮箱为公开邮箱 `Zhang Yunfei <zyf8827@gmail.com>`。
- **协议与工具链开源解耦**：
  - MCP 模块独立打包并规范命名为 `@zyf8827/tern-mcp`，发布标识对齐 MCP Registry：`io.github.zyf8827/tern`。
  - 准备官方 MCP Registry 描述规范文件 `server.json` 并通过 `mcp-publisher` 验证。
  - 官方 Agent Skill `tern-project` 正式集成入主仓库 `skills/tern-project/`，提供 `npx skills add` 与手动安装双通道指引。
  - 镜像构建与初始化脚本解耦：全面默认官方上游源（npm / Debian / Ubuntu），中国镜像转为可选环境变量。
- **通知系统重构**：
  - 抽象通用 Webhook 架构（Generic Webhook），支持带 HMAC-SHA256 签名的 JSON 数据推送。
  - 钉钉机器人转换为通知渠道的可选 Provider，彻底消除写死依赖。
- **脱敏与用例通用化**：
  - 全面清除代码、注释、测试、文档中所有的私有内网 IP（192.168.x.x）、私有仓库地址与真实业务名词。
  - 登录示例与 Fixture 归一化为通用 Mock 登录（`/api/auth/mock-login`）与 `session_token`。
- **持续集成与代码质量**：
  - 新增 GitHub Actions CI 工作流（`.github/workflows/ci.yml`），覆盖 install / build / lint / typecheck / unit tests。
  - 新增资产发布工作流（`.github/workflows/release-assets.yml`），支持 Tag 自动编译发布单文件 `dist/tern-mcp.mjs`。
  - 引入 Prettier、ESLint 9/10 Flat Config 与 `.editorconfig` 规范。

---

## [0.2.0] - 2026-09-17

### 新增特性

- **测试集（Test Suite）系统**：
  - 支持基于标签、模块、版本的多维声明式选择器。
  - 支持多测试集各自绑定独立环境（如 dev / staging），实现单次运行多环境并跑与去重执行。
- **设备反向代理（Device Proxy）**：
  - Worker 自动建立 `127.0.0.1` 双向透传反向代理，解决 Chromium secure context 下媒体录音/摄像权限限制。
- **测试资产系统（Assets）**：
  - 用例仓库内 `cases/_assets/` 静态素材同步、哈希内容寻址与下发。
  - 支持 `ternAsset('...')` 字面量解析与运行时路径注入。
- **会话与认证抽象（Auth Recipes）**：
  - 支持 `api`、`form`、`storage` 三种免侵入式登录配方。
  - 凭据采用 `${ENV:VAR}` 占位符隔离，平台环境加密存储，执行端动态解析注入。

---

## [0.1.0] - 2026-09-10

### 初始版本

- 核心 Server 与分布式 Worker 架构。
- 基于 SQLite 的轻量单文件持久化。
- 基于 esbuild 的用例 Bundle 打包与下发机制。
- 基于 Chrome DevTools Protocol (CDP) 的实时控制台与只读画面广播。
