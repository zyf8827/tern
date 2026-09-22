# 贡献指南 (Contributing)

感谢关注 Tern！这是一个面向 Coding Agent 与开发者的个人开源项目。欢迎提交 Issue 或 Pull Request 来修复问题、改进文档或贡献新功能。

---

## 本地开发

### 环境要求

- Node.js ≥ 20
- pnpm 10
- Chromium（Playwright 驱动）

### 构建与测试

```bash
# 安装依赖并构建
pnpm install
pnpm -r build

# 运行单元测试（测试从各包 dist/ 运行，必须先 build）
pnpm test:unit

# 代码检查与格式化
pnpm lint
pnpm format:check
```

### 本地调试

```bash
# 启动本地 Server 与 1 个 Worker
bash scripts/dev.sh up 1

# 查看状态与日志
bash scripts/dev.sh status
bash scripts/dev.sh logs

# 停止服务
bash scripts/dev.sh down
```

---

## 贡献规范

1. **包依赖方向**：`@tern/sdk` 为零依赖叶子包，所有跨服务通信类型由该包导出；用例仓库严禁直接 import `@tern/*` 内部模块。
2. **测试验证**：提交 PR 前请确保 `pnpm -r build` 和 `pnpm test:unit` 全部通过。
3. **脱敏与安全**：请勿在提交记录、测试用例或文档中包含任何私有网络 IP、公司内部标识或未经授权的生产凭据。通用演示一律使用 `127.0.0.1` 或 `http://localhost:7430`。
4. **提交方式**：Fork 本仓库，在独立分支修改并提交 PR 到 `main` 分支。
