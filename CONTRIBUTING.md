# 贡献指南 (Contributing to Tern)

感谢你对 Tern 项目的关注与支持！Tern 是一个面向 Coding Agent 与现代开发团队的开源 E2E 测试平台。我们欢迎各种形式的贡献，包括提出 Issue、完善文档、新增特性、修复缺陷以及分享用例模板。

---

## 1. 行为准则

参与本项目即表示你同意遵守 [行为准则 (CODE_OF_CONDUCT.md)](./CODE_OF_CONDUCT.md)。请始终保持友好、尊重与包容的交流态度。

---

## 2. 快速开始与本地开发

### 环境准备

- Node.js ≥ 20
- pnpm ≥ 10.30.2
- Linux / macOS / WSL2 (推荐 Linux 环境以获得与 Docker/CI 一致的体验)
- Chromium 系统依赖（用于 Playwright 浏览器）

### 获取代码与依赖安装

```bash
git clone https://github.com/zyf8827/tern.git
cd tern

# 安装依赖并全量构建
pnpm install
pnpm -r build
```

### 运行测试与代码风格检查

```bash
# 运行单元测试
pnpm test:unit

# 运行代码规范检查
pnpm lint

# 运行格式化检查
pnpm format:check
```

### 本地启动平台服务

```bash
# 启动本地开发服务（后台启动 server 与 1 个 worker）
bash scripts/dev.sh up 1

# 检查服务状态
bash scripts/dev.sh status

# 停止服务
bash scripts/dev.sh down
```

---

## 3. 分支管理与 Pull Request 流程

1. **Fork** 本仓库到你的 GitHub 个人账号下。
2. 从 `main` 分支切出新的功能或修复分支：
   ```bash
   git checkout -b feat/your-feature-name
   # 或
   git checkout -b fix/your-bug-fix
   ```
3. 在本地完成编码、添加对应的单元测试并确保测试通过：
   ```bash
   pnpm -r build
   pnpm test:unit
   pnpm lint
   ```
4. 提交你的改动（推荐使用 Conventional Commits 格式）：
   ```bash
   git commit -m "feat(scheduler): add support for multi-worker tags matching"
   ```
5. 推送到你的个人分支并向官方仓库的 `main` 分支发起 Pull Request。
6. 关注 CI 状态与 Code Review 评论，根据反馈更新代码。

---

## 4. 架构设计与编码规范

在修改核心包之前，请务必阅读以下设计文档：

- [架构设计 (Architecture)](docs/architecture.md)
- [Agent 协作规范 (AGENTS.md)](AGENTS.md)
- [MCP 协议接入指南 (MCP Guide)](docs/mcp.md)
- [Skill 安装与使用指南 (Skills Guide)](docs/skills.md)

### 约束

- **核心包边界清晰**：`@tern/sdk` 必须保持零运行时依赖的叶子包，所有跨服务类型由此包导出。
- **不可引入内部依赖**：用例仓库禁止直接 import `@tern/*` 内部模块。
- **脱敏规范**：任何代码、测试用例、文档或资产中**严禁包含内部真实业务名称、私有网络 IP（如 192.168.x.x）或未经授权的生产凭据**。通用演示一律使用 `127.0.0.1`、`http://localhost:7430` 或 `example.com`。

---

## 5. 报告缺陷与提出新特性

- **缺陷反馈**：请使用 GitHub Issue 模板提交 [Bug Report](https://github.com/zyf8827/tern/issues/new?template=bug_report.yml)，并尽可能提供复现步骤、运行环境以及报错日志。
- **新功能建议**：请使用 [Feature Request](https://github.com/zyf8827/tern/issues/new?template=feature_request.yml) 说明你的使用场景与方案设计。
