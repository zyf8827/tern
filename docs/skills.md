# Tern Agent Skill（tern-project）安装与使用指南

`tern-project` 是专为 Coding Agent（如 Claude Code, Cursor, Windsurf 等）打造的领域特定 Skill，用于自动化管理与编写 Tern E2E 测试用例。

它向 Agent 传授：

- 如何从零搭建符合 Tern 规范的用例 Git 仓库（`tern.yaml` + `cases/` + 登录配方 + 变量清单）；
- 编写原生 Playwright 用例（带 `@tern` frontmatter、`devices` 麦克风/摄像头虚拟模拟、`ternAsset()` 测试资产）；
- 配置 `auth` 登录配方（接口登录 `mode: api`、表单登录 `mode: form`、存储直写 `mode: storage`）；
- 设计平台运行变量清单（`env.variables`），实现**凭据不进 Git、换环境只需换平台值**；
- 平台测试集（Test Suite）的最佳实践（冒烟集、全量集、多集多环境并跑）；
- 真实环境 E2E 实跑踩坑与规避模式（Ant Design 组件断言、getUserMedia 安全源反代等）。

---

## 1. 安装方式

### 方式 A：通过 skills CLI 一键添加（推荐）

如果你的环境安装了 `skills` CLI（如 `@agent-skills/cli` 或类似生态工具）：

```bash
npx skills add https://github.com/zyf8827/tern.git --skill tern-project
```

若针对当前项目本地安装：

```bash
npx skills add https://github.com/zyf8827/tern.git --skill tern-project --local
```

### 方式 B：手动复制到 Agent Skills 目录（通用后备方案）

直接将本仓库中的 `skills/tern-project/` 目录复制到你的 Coding Agent 所在配置目录即可：

#### 1. Claude Code

```bash
mkdir -p ~/.claude/skills/
cp -r skills/tern-project ~/.claude/skills/
```


#### 2. Cursor / Windsurf / 其他 Agent

将 `skills/tern-project/SKILL.md` 及其 `references/` 目录内容软链接或复制到项目的规则/提示词目录下，或在 Agent 设置的 Custom Instructions / Rules 中引用。

---

## 2. 目录结构说明

安装后的 `tern-project` 包含完整的技能规范与知识库：

```text
skills/tern-project/
├── SKILL.md                          # 核心操作规范、工作流与 sync 错误对照表
├── assets/
│   ├── case-repo-AGENTS.md.template  # 新用例仓库内置的 Agent 规范模板
│   └── tern.yaml.template            # 新项目 tern.yaml 配置文件模板
└── references/
    ├── auth-recipes.md               # 登录配方模式（api / form / storage）详解
    ├── case-pitfalls.md              # 真实环境 E2E 编写避坑指南
    ├── env-variables.md              # 运行变量清单与 Secret 设计规范
    └── test-suites.md                # 平台测试集（多集多环境并跑）设计规范
```

---

## 3. 使用场景与对话触发

在日常开发与维护中，可以直接向 Agent 提出如下需求唤醒 `tern-project`：

- **新建用例项目**：
  > "帮我为业务前端创建一个新的 Tern 用例仓库，入口是 http://127.0.0.1:3000，使用 API 登录，准备冒烟用例。"
- **编写与扩充用例**：
  > "在 cases/order/ 模块下新增一条订单创建与支付成功的 E2E 测试用例，要求打上 smoke 标签。"
- **排查用例失败**：
  > "刚刚发起的 run-102 中有 3 条用例报超时失败，请调用 tern_get_failure_summary 排查根因并修复用例。"
- **创建测试集**：
  > "在平台创建一个名为 regression-staging 的测试集，绑定 staging 环境，包含所有 regression 标签用例。"

Agent 将依据 `SKILL.md` 规范与 `tern_*` MCP 工具链进行自动化操作。
