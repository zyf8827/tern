# Tern MCP Server 接入与发布指南

Tern Model Context Protocol (MCP) Server 为 Coding Agent（如 Claude Code, Cursor, Windsurf, Zed, Antigravity 等）提供对 Tern E2E 测试平台的标准 stdio 接入能力。Agent 可直接调用 `tern_*` 工具查询项目、获取用例、同步用例、创建测试集、发起测试运行、分析失败并获取截图。

---

## 1. 运行方式

### 方式 A：通过 npm / npx 运行（推荐）

当 `@zyf8827/tern-mcp` 发布到 npm 后，可直接通过 `npx` 运行：

```bash
npx -y @zyf8827/tern-mcp
```

### 方式 B：通过 GitHub Release 产物直接运行（零依赖单文件）

从 [GitHub Releases](https://github.com/zyf8827/tern/releases) 下载 `tern-mcp.mjs`（Node.js ≥ 20 直接运行）：

```bash
node /path/to/tern-mcp.mjs
```

### 方式 C：源码本地构建与运行

在 Tern 仓库内：

```bash
# 1. 安装依赖并构建
pnpm install
pnpm -r build

# 2. 打包零依赖单文件 bundle
node scripts/bundle-mcp.mjs dist/tern-mcp.mjs

# 3. 运行
node dist/tern-mcp.mjs
```

---

## 2. 环境变量配置

Tern MCP Server 通过环境变量连接 Tern Server：

| 环境变量     | 说明                                 | 默认值                  | 示例                                                  |
| ------------ | ------------------------------------ | ----------------------- | ----------------------------------------------------- |
| `TERN_URL`   | Tern 平台服务 HTTP 地址              | `http://127.0.0.1:7430` | `http://10.0.0.12:7430` 或 `https://tern.example.com` |
| `TERN_TOKEN` | API 认证 Token（如果平台开启了认证） | （空）                  | `tern_sec_xxxxxxxxxxxx`                               |

---

## 3. 常见客户端配置示例

### 3.1 Claude Desktop

配置文件路径：

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tern": {
      "command": "npx",
      "args": ["-y", "@zyf8827/tern-mcp"],
      "env": {
        "TERN_URL": "http://127.0.0.1:7430",
        "TERN_TOKEN": "your-token-if-configured"
      }
    }
  }
}
```

若使用本地 `dist/tern-mcp.mjs`：

```json
{
  "mcpServers": {
    "tern": {
      "command": "node",
      "args": ["/absolute/path/to/tern/dist/tern-mcp.mjs"],
      "env": {
        "TERN_URL": "http://127.0.0.1:7430"
      }
    }
  }
}
```

### 3.2 Claude Code CLI

添加 MCP 服务器：

```bash
claude mcp add tern -- npx -y @zyf8827/tern-mcp
```

或使用本地文件并指定环境变量：

```bash
claude mcp add tern -e TERN_URL=http://127.0.0.1:7430 -- node /path/to/dist/tern-mcp.mjs
```

### 3.3 Cursor

在 Cursor 设置中打开 **Features > MCP Servers > Add New MCP Server**：

- **Name**: `tern`
- **Type**: `command`
- **Command**: `npx -y @zyf8827/tern-mcp`
- **Environment Variables**:
  - `TERN_URL`: `http://127.0.0.1:7430`

### 3.4 Zed

在 `~/.config/zed/settings.json` 中配置：

```json
{
  "context_servers": [
    {
      "id": "tern",
      "command": {
        "path": "npx",
        "args": ["-y", "@zyf8827/tern-mcp"],
        "env": {
          "TERN_URL": "http://127.0.0.1:7430"
        }
      }
    }
  ]
}
```

---

## 4. MCP 工具列表

Tern MCP Server 提供完整的 `tern_*` 工具集：

| 工具名称                   | 功能描述                                                       |
| -------------------------- | -------------------------------------------------------------- |
| `tern_list_projects`       | 列出平台接入的所有用例项目（ID、名称、Git 地址、状态）         |
| `tern_get_project`         | 获取单个项目的详情、配置与最近一次同步报告                     |
| `tern_add_project`         | 接入新用例项目（支持 HTTP 账号密码与 SSH 私钥认证）            |
| `tern_sync_project`        | 强制同步项目用例仓库，返回 lint 校验、编译与资产索引报告       |
| `tern_list_cases`          | 多维查询用例（支持 project/tags/version/module/q 等条件）      |
| `tern_get_case`            | 查询单条用例元数据（frontmatter、设备配置）与 TypeScript 源码  |
| `tern_list_suites`         | 列出项目测试集、健康度与用例命中数（发起运行前主入口）         |
| `tern_get_suite`           | 查询测试集选择器定义与环境/账号绑定                            |
| `tern_create_suite`        | 创建测试集（声明式选择器 + env/account 绑定）                  |
| `tern_update_suite`        | 更新测试集配置（改名联动定时任务）                             |
| `tern_delete_suite`        | 删除测试集                                                     |
| `tern_preview_run`         | 运行前 dry-run 预览（按环境分组、去重明细）                    |
| `tern_run_cases`           | 发起测试运行（支持多测试集多环境并跑、多维筛选，默认等待完成） |
| `tern_get_run`             | 获取测试运行详情、用例汇总与通过率统计                         |
| `tern_wait_run`            | 轮询等待测试运行结束并返回结果                                 |
| `tern_cancel_run`          | 取消正在执行的测试运行                                         |
| `tern_delete_run`          | 删除测试运行记录                                               |
| `tern_retry_failed`        | 原位重跑上一次运行中失败的用例集                               |
| `tern_get_execution`       | 获取单条用例执行明细、控制台日志、步骤时间线                   |
| `tern_get_screenshot`      | 下载失败用例的首张截图（base64 image 协议直传）                |
| `tern_get_failure_summary` | 按错误特征签名聚合批量失败，附带首组截图与复发历史             |
| `tern_set_case_quarantine` | 手动隔离 / 解除隔离不稳定用例（Flaky 治理）                    |
| `tern_list_workers`        | 查询所有 Worker 实例状态、版本与并发槽利用率                   |
| `tern_list_schedules`      | 查询定时回归调度任务状态与下次触发时间                         |

---

## 5. MCP Registry 上架指引

Tern MCP Server 的官方 Registry 注册材料已就绪：

- 注册文件：`server.json`（已通过 `mcp-publisher validate server.json` 官方校验）
- Server 唯一标识：`io.github.zyf8827/tern`
- Schema：`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`

### 发布步骤（需项目所有者授权）

由于发布到官方 Registry 需要所有者 GitHub 账号认证，请按以下步骤操作：

```bash
# 1. 确保已安装 mcp-publisher（官方 Go 工具）
mcp-publisher --help

# 2. 登录 GitHub 账号（进行交互式 OAuth 授权）
mcp-publisher login github

# 3. 校验 server.json 结构
mcp-publisher validate server.json

# 4. 发布到官方 MCP Registry
mcp-publisher publish server.json
```

发布成功后，全球 Agent 可直接通过 `io.github.zyf8827/tern` 标识发现并安装 Tern MCP 服务。
