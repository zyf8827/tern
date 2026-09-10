# Tern 测试集（Test Suite）使用指南

测试集是平台侧的**可命名、可复用的用例选择 + 执行前提绑定**：一个名字对应「跑哪些用例（selector）+ 在什么环境、以什么账号跑（env / account）」。它**不属于用例仓库**——仓库管「用例怎么写」（frontmatter、auth 配方、变量清单），测试集管「这批用例怎么被反复、正确地跑」。运行时 run 引用测试集（可多个），或继续直接指定筛选/用例范围，二者并存。

设计细节见主仓库 `docs/test-suite-design.md`；本指南讲 Agent 什么时候该建集、怎么建、多环境并跑的语义。

## 什么时候该建一个测试集

**该建**——满足「稳定口径 + 反复引用」：

- **冒烟集**：每次改动后都要跑的那一小撮（`tags: [smoke]` + 核心链路点名）；
- **模块全量回归集**：按 `module` 一把抓（如 `module: [ocr]`）；
- **带执行前提的成组用例**：需要特定环境（如依赖后端 `mock.login=true` 的后门用例必须打 dev）或特定账号（`auth: admin` 管理端用例）——**前提跟着集走**，引用者不再需要知道 CLIENT_ID 配在哪个环境；
- **跨环境回归口径**：同一批用例要在 dev 与 staging 各验一遍——建两个集（各自绑环境），一次 run 并跑。

**不该建**：

- 一次性排查/临时验证（直接 `tern_run_cases(caseIds=…)` 更快，跑完即散）；
- 口径还不稳定的探索期组合（先手选，口径固化后再沉淀成集）；
- 试图用集表达用例间顺序或依赖（平台不保证顺序，用例必须独立）；
- 用集替代用例仓库的筛选维度——`module`/`version`/`tags` 是用例自描述，测试集是对它们的**组合引用**，别让两处口径漂移（例如集里写死 `module: ocr` 后用例目录改名为 `transcript-ocr`，集会静默变空——健康度会警示，见下文「防呆」）。

## 选择器：怎么圈用例

selector = 筛选条件 + 显式包含/排除，**排除优先**（`excludeCaseIds` 压过一切包含手段）：

| 字段                         | 说明                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `tags` / `tagMode: any\|all` | 标签筛选（any=任一命中，默认；all=全部命中）                                          |
| `excludeTags`                | 排除标签（如 `flaky`）                                                                |
| `version[]` / `module[]`     | 被测系统版本 / 功能模块                                                               |
| `q`                          | 按 ID/标题/描述关键字                                                                 |
| `includeCaseIds[]`           | 显式点名包含（与筛选命中取并集；可点当前不存在、尚未 push 的 ID——git 演进后自动生效） |
| `excludeCaseIds[]`           | 显式排除（最高优先级，临时下线某条的最快手段）                                        |
| `includeQuarantined`         | 纳入已隔离（flaky）用例（默认排除）                                                   |

**空 selector = 项目全部 active 用例**（全量回归集是合法诉求；UI 会显著标注「全量」）。

选择器是**声明式**的，解析发生在引用时：新 push 的用例打上 tag，下一次引用该集自动纳入；`deleted/invalid/disabled` 用例一律不进。

## 执行前提绑定：env / account / params

- `env`：绑定平台环境名（值在平台项目页配置）。**只存名字引用不复制值**——环境值更新后，下一次引用自动用新值；
- `account`：绑定 `tern.yaml` `auth.accounts` 账号名，运行时映射为 `AUTH_ACCOUNT`——**只覆盖未声明 frontmatter `auth:` 的用例**（显式写了 `auth: admin` 或 `auth: none` 的用例不受影响）。仓库里账号还没建时允许保存（软校验），run 创建时才硬校验；
- `params`：绑定非敏感运行参数（如功能开关）。敏感值仍放环境（secret 加密），不要进集的 params。

层级：**run 显式指定 > 测试集绑定 > 环境值**。

## 多集多环境并跑（核心语义）

一次 run 可引用多个测试集，**各用各的 env**，平台按「**用例 × 环境**」去重执行：

| 场景                                          | 结果                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| 用例 X 在集 A（env dev）与集 B（env dev）     | 执行 **1 次**（dev）                                                            |
| 用例 X 在集 A（env dev）与集 B（env staging） | 执行 **2 次**（各环境各一次，各自统计与产物）                                   |
| run 显式传了 `env`（如 `--env staging`）      | **覆盖拉平**：所有集都打进 staging，各执行 1 次（"今天就想拿这套集打 staging"） |

约束（fail-fast，创建 run 即报错）：

- 引用的集必须存在、启用、且与 run 同属一个 project；
- 集解析命中 0 条 → 400 `SUITE_RESOLVED_EMPTY`（点名是哪个集）；
- **同一环境上下文内**，多个集绑定了不同账号（`SUITE_ACCOUNT_CONFLICT`）或同键不同值参数（`SUITE_PARAM_CONFLICT`）→ 400；run 显式给出该值可解。跨环境天然无冲突（dev 用 default、staging 用 admin 完全合法）；
- 每个引用到的环境都做完备性校验（缺值 → `MISSING_ENV_VALUES` 列出缺失键）。

重跑语义：`retry-failed` / `rerun` 按（用例 × 环境）对原位重跑——失败在哪个环境，就在哪个环境重跑。

## Agent 操作配方

```
# 看有哪些集（含命中数与健康度）——发起运行前先看这里
tern_list_suites(project="portal")

# 引用测试集发起运行（多集多环境并跑；wait 默认开）
tern_run_cases(project="portal", suites=["smoke", "regression"])

# 显式换环境打这套集（拉平）
tern_run_cases(project="portal", suites=["smoke"], env="staging")

# 发起前自查（不执行不落库）：总数、按环境分组的构成、去重明细
tern_preview_run(project="portal", suites=["smoke", "regression"])

# 建集 / 改集
tern_create_suite(project="portal", name="smoke", selector={tags:["smoke"]}, env="dev",
                  account="default", description="每次改动后冒烟")
tern_update_suite(project="portal", name="smoke", excludeCaseIds=["portal/task/rename-delete"])
```

CLI 等价：`tern suites <project> list|show|create|update|rm|preview`、`tern run --suite smoke --suite regression --wait`、`tern runs list --suite smoke`。

## 建集防呆清单

- **先 `tern_preview_run` 再创建**：确认命中数符合预期、环境分组正确（直接指定范围落在「无环境」组多半是忘了绑环境）；
- **健康度三看**（`tern_list_suites` 返回 `health`）：`resolvedCount=0` 空集（用例被删/改名/隔离）、`danglingIncludes` 悬空引用（点名的 caseId 已不存在——git 演进正常现象但要记得清理）、`envStatus=incomplete/missing`（绑定的环境缺值或已删）；
- **命名**：小写 kebab-case，项目内唯一，按用途起名（`smoke` / `ocr-full` / `admin-ops` / `regression-staging`），别按人名或日期；
- **集改名安全**：平台会联动重写引用它的定时任务；删除集则定时任务触发时明确报错（不会静默空跑）；
- **同一环境内一个用例只有一种账号/参数形态**：需要变体（同 env 不同参数各跑一遍）时，目前不支持——拆环境或拆集表达（参数变体属平台 `variants` 方向，未实现）。
