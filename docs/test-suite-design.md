# Tern 测试集（Test Suite）功能设计

> 状态：**已实现**（v2 多环境语义；migration 12 + `selector.ts` / `suites.ts` + createRun 上下文归并；单测 `suites.test.ts` + e2e `[16.6]`）。范围：测试集实体（CRUD）、解析模型（筛选 + 显式包含/排除）、run 关联多测试集（**每个测试集可单独绑定环境，按「用例 × 环境」去重执行**）、定时任务集成、四端（API/SDK/CLI/MCP/Web）。
> 原则：不引入外部依赖；沿用 SQLite 单文件 + scope 快照 + fail-fast 的既有架构；所有能力对 CLI / API / MCP / Web 四端一致。
> v2 变更：多测试集不再要求环境统一——环境从 run 级属性升级为 **item 级执行上下文（env context）**，每个测试集可用自己的环境，同用例跨环境各执行一次、同环境去重（§3.2、§5）。
>
> 实现落点备忘：`suites` / `run_envs` 表（migration 12）；`batch_items.run_env_id`（NULL = 既有单环境路径，行为不变）；`planRunSelection` 与 `previewRun` 共用（所见即所得）；`assignRun` 逐条目合并「上下文参数 + run 级显式参数」（worker 协议零改动）；`rerunRun` 按（用例×环境）对原位重建；单侧绑定账号/参数 = 采纳，只有同键"都有值且不同"才 400。

---

## 0. 动机与定位

### 0.1 现状问题

选择逻辑今天散落在两处，且都是**临时拼装**：

- 每次 run 手填 `tags/version/module/caseIds`（`CreateRunPayload`），跑完即散；
- 定时任务 `schedules.scope` 存了一份筛选 JSON——本质上已经是"保存下来的选择"，但它锁死在 cron 上，不能被手工 run 复用，也不能组合。

真实痛点（以典型业务项目为例）：

| 稳定集合                               | 今天怎么跑              | 问题                                    |
| -------------------------------------- | ----------------------- | --------------------------------------- |
| 冒烟集（`smoke` + 关键链路）           | 每次手选 tags           | 重复拼参数，口径靠记忆                  |
| OCR 全量回归                           | tags + module 组合      | 新人/Agent 不知道正确组合               |
| 管理端用例                             | 需要 `auth: admin` 账号 | 账号前提没有随"集合"声明，容易漏配      |
| 依赖 mock 后门的用例                   | 只能打 dev 环境         | 环境前提没有随"集合"声明，换环境即失败  |
| 同一批用例要在 dev 与 staging 各验一遍 | 发两个 run              | 两个环境无法在一次 run 里表达，结果分散 |

### 0.2 一句话定位

**测试集 = 项目内一组可命名、可复用的用例选择 + 执行前提（环境 / 账号）绑定。**

run 引用测试集（可多个，各自带环境，按「用例 × 环境」去重执行），或直接指定用例范围（现状保留），二者可并存。

### 0.3 职责边界（与 run / schedule 的分工）

| 实体                 | 回答的问题                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **测试集（suite）**  | 跑**哪些**用例；在**什么环境**、以**什么账号**（集级绑定，run 可覆盖）                     |
| 测试运行（run）      | 本次执行的参数覆盖、worker、重试次数；**创建时快照**实际执行构成（含每个用例的环境上下文） |
| 定时任务（schedule） | **什么时候**触发（cron）、标题前缀、防重叠                                                 |

测试集不携带调度与基础设施属性（cron、workerId）——那些属于 run/schedule。

### 0.4 成熟平台实践对照

| 平台                               | 对应机制                                                                                           | Tern 的取舍                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| pytest                             | markers + `-m "smoke and not slow"`                                                                | tag 筛选 + excludeTags/excludeCaseIds，**排除优先**语义对齐                                                                    |
| Robot Framework                    | 目录即 suite，`--include/--exclude` 组合 tag                                                       | 显式 include/exclude 列表 + tag 条件并存，exclude 赢                                                                           |
| TestRail / Xray / Azure Test Plans | Test Suite → Test Plan → Test Run（run 从 plan **快照**；一个 plan 可含多环境配置）                | 沿用"创建 run 时快照 batch_items + scope"模式；环境随条目落位（§3.2）                                                          |
| Playwright                         | `--grep` 标签筛选；多 project 配置（不同 baseURL/设备并行矩阵）；新近的 test list（JSON 固定清单） | 动态筛选（tag）与固定清单（includeCaseIds）同时支持；「每集一环境、同用例跨环境各跑一次」正对应 Playwright 多 project 矩阵语义 |
| Cypress / cypress-grep             | tag 过滤注入                                                                                       | 同 tag 语义                                                                                                                    |
| GitHub Actions / CI/CD pipelines   | workflow 声明需要哪些变量，平台按环境供值；一个 pipeline 可含多个 environment 的 job               | 环境绑定沿用 F1 既定分层，不新造凭据通道                                                                                       |

共性实践采纳进本设计：**选择器声明式、解析发生在使用时、run 侧快照保审计、排除优先、命名引用可组合、执行前提随集声明、跨环境矩阵按条目去重**。

### 0.5 需求追溯

| 需求（原始诉求）                                        | 对应章节                                          |
| ------------------------------------------------------- | ------------------------------------------------- |
| 测试集只能关联一个 project                              | §1 D7、§2                                         |
| 基于 tag 或直接指定包含/排除某些用例                    | §1 D2/D3、§3.1                                    |
| 基于各种条件筛选或排除用例                              | §3.1（version/module/tags/tagMode/q/excludeTags） |
| 用例依赖指定环境或账号                                  | §3.3（集级 env/account 绑定）；用例级依赖见 §10   |
| 一次 run 关联多个测试集                                 | §3.2                                              |
| **多个测试集每个单独设环境，按「用例 + 环境」去重执行** | §1 D9、§3.2、§5                                   |
| 或直接指定用例范围执行                                  | §4.2（既有选择器保留，与 suites 并存）            |

---

## 1. 核心决策

| #   | 决策                                                                                                                                                                                   | 理由                                                                                                                                                                                                                                    | 放弃的备选                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **测试集存平台侧（SQLite `suites` 表），不进用例仓库**                                                                                                                                 | 集要绑定的环境/账号是平台运营数据（环境值本来就只存在平台、secret 不进 git）；与 environments / schedules / webhooks 的既有归属一致；Agent 经 MCP/CLI 完整可管                                                                          | tern.yaml 增 `suites:` 节点——选择逻辑可 code review，但环境绑定会破坏"凭据不进 git"原则，且改集要动代码库、过 sync 周期；作为折中，未来可加 `tern suites export`（yaml 备份/迁移），本期不做 |
| D2  | **选择器声明式（筛选 + 显式包含/排除），解析发生在使用时**（run 创建 / 预览 / 健康度计算），不在保存时物化用例清单                                                                     | 新用例打上 tag 自动进集（pytest marker 语义）；审计由 run 侧既有快照保证；"固定清单"需求用纯 includeCaseIds 表达                                                                                                                        | 保存时物化 case 列表（TestRail 旧式）——集合会随仓库演进腐化，需人工同步                                                                                                                      |
| D3  | **排除优先**：includeCaseIds ∩ excludeCaseIds = 排除                                                                                                                                   | Robot `--exclude`、pytest `not` 的通行语义；"临时下线某条"是最高频操作，必须压过一切包含手段                                                                                                                                            |
| D4  | **空选择器 = 项目全部 active 用例**                                                                                                                                                    | 与 createRun 现状语义一致（仅 project 无筛选 = 全选）；"全量回归集"是合法诉求；预览/健康度显著标注「全量」防误触                                                                                                                        |
| D5  | **run 侧多源并集**：`suites ∪ 筛选(tags/version/module/q) ∪ caseIds`，按「用例 × 环境上下文」去重保序                                                                                  | 与既有"filters ∪ caseIds"心智模型一致——**Tern 的选择器都是并集，只有排除参数（excludeTags/excludeCaseIds）收窄**；同一用例进多个集时，同环境只跑一次、不同环境各跑一次                                                                  | 交集语义（suite 命中 ∩ tags 命中）——与现状 breaking，且混合场景更难解释                                                                                                                      |
| D6  | **测试集可带 env / account / params 绑定；同一环境上下文内的不一致 fail-fast**                                                                                                         | "管理端集"绑 admin 账号、"mock 依赖集"绑 dev 环境是核心诉求；跨环境天然无冲突；**同一环境**内多个来源集对账号/参数键给出不同值 → 400 明示（fail-fast），run 显式值永远优先                                                              | 静默 last-wins——排查"为什么用了别的账号"的成本远高于创建时报错；v1 稿的"多集不同 env 一律 400"已废弃（被 D9 取代）                                                                           |
| D7  | **测试集只属于一个 project；run 引用的测试集必须同属该 run 的 project**                                                                                                                | run 单项目约束（v0.5）不动摇；跨项目组合是"测试计划（plan）"层的事，列为非目标                                                                                                                                                          |
| D8  | **隔离（quarantined）用例默认不解析进集**，集可声明 `includeQuarantined`，run 级覆盖                                                                                                   | 沿 F5 语义；"隔离复验集"是真实工作流                                                                                                                                                                                                    |
| D9  | **环境是 item 级执行上下文（env context），不是 run 级单值**：多测试集各自的环境在 run 内并存，batch_items 按（case, env 上下文）落位去重；run 显式 `env` = 全局覆盖（拉平为单一环境） | 一次 run 完成"dev 冒烟 + staging 回归"的矩阵诉求；执行侧 assignRun 本就逐任务组装 params（runtime.ts:458），下沉到 item 级对 worker 协议零改动；run 显式 env 保留"今天就想拿这套集打 staging"的日常覆盖场景，此时退化为 v0.5 单环境行为 | 维持 run 级单环境 + 冲突 400——表达力不足，逼用户拆 run、结果分散                                                                                                                             |

---

## 2. 数据模型

一次 migration（id 顺延当前最大值）承载全部 schema 变更。

### 2.1 测试集表

```sql
CREATE TABLE suites (
  id          TEXT PRIMARY KEY,            -- ts_ 前缀 ULID
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,               -- 项目内唯一，小写 kebab-case（smoke / ocr-full / admin-ops…）
  description TEXT NOT NULL DEFAULT '',
  selector    TEXT NOT NULL DEFAULT '{}',  -- SuiteSelector JSON（§3.1）
  env         TEXT,                        -- 绑定环境名（项目内 environments.name；引用，不复制值）
  account     TEXT,                        -- 绑定 AUTH_ACCOUNT（tern.yaml auth.accounts 账号名）
  params      TEXT NOT NULL DEFAULT '{}',  -- 绑定运行参数（非敏感；敏感值仍走环境/secretParams）
  enabled     INTEGER NOT NULL DEFAULT 1,  -- 停用后不可被 run/schedule 引用（400 SUITE_DISABLED）
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(project_id, name)
);
```

`projects` 删除时级联清理 suites（沿用现有 children 清理模式）。

### 2.2 环境上下文表（run 内多环境，D9）

```sql
-- 一个 run 内的每个「环境上下文」一行：同名环境合并为一个上下文；无环境的来源共享隐式上下文（run_env_id = NULL）
CREATE TABLE run_envs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       TEXT NOT NULL REFERENCES batches(id),
  env_name       TEXT,                        -- NULL = 无环境（仅显式参数）
  params         TEXT NOT NULL DEFAULT '{}',  -- 该上下文解析后的明文参数（环境非 secret 值 + 来源测试集 params）
  params_secret  TEXT,                        -- 该上下文解析后的 secret 密文（AES-GCM，同 F1）
  device_proxy   TEXT,                        -- F9：环境级设备代理模式快照（上下文各自记录）
  position       INTEGER NOT NULL DEFAULT 0,  -- 展示顺序（来源测试集首次出现的顺序）
  UNIQUE(batch_id, env_name)                  -- SQLite 视 NULL 互不相等，隐式上下文由代码保证唯一
);

ALTER TABLE batch_items ADD COLUMN run_env_id INTEGER REFERENCES run_envs(id);
-- 去重键（应用层保证）：(batch_id, case_id, run_env_id)；NULL = 沿用 batches.params 的旧行为（单环境 run 与历史数据完全兼容）
```

- **`batches.params / params_secret` 语义收窄为「run 级显式参数」**（payload.params / secretParams，对全部上下文生效、assign 时覆盖合并）；不引用测试集的单环境 run 维持现状写法（值仍在 batches 上，run_env_id=NULL）；
- `batches.env_name` 保留：run 显式环境名，或全部上下文同环境时的该环境（展示兼容；多环境时为 NULL，看 `run_envs`）；
- `run_envs.params` 在**创建时**完成解析（环境值展开 + 来源测试集 params 覆盖 + 完备性校验），此后 run 内不再变化——与现状"创建时快照、assign 只解密下发"的纪律一致。

### 2.3 SDK 类型（packages/sdk）

```ts
export interface SuiteSelector {
  version?: string[];
  module?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  excludeTags?: string[];
  q?: string;
  /** 显式点名包含（与筛选命中取并集；被 excludeCaseIds 命中则仍排除） */
  includeCaseIds?: string[];
  /** 显式排除（最高优先级） */
  excludeCaseIds?: string[];
  /** 纳入已隔离用例（默认排除；run 级 includeQuarantined 覆盖） */
  includeQuarantined?: boolean;
}

export interface SuiteInfo {
  id: string; // ts_…
  project: string;
  name: string;
  description: string;
  selector: SuiteSelector;
  env: string | null;
  account: string | null;
  params: Record<string, string>;
  enabled: boolean;
  /** 解析健康度（读取时现算，便宜 SQL） */
  health: SuiteHealth;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SuiteHealth {
  resolvedCount: number; // 当前解析命中数
  quarantinedExcluded: number; // 因隔离被排除的数量
  /** includeCaseIds 中当前不存在/非 active 的 ID（git 演进正常现象，警示不报错） */
  danglingIncludes: string[];
  /** 同时出现在 include 与 exclude 的死条目 */
  deadEntries: string[];
  /** 绑定环境是否存在 + 值是否配齐清单（env 为 null 时为 null） */
  envStatus: 'ok' | 'incomplete' | 'missing' | null;
  /** 绑定账号是否存在于当前 auth 快照（account 为 null 时为 null） */
  accountKnown: boolean | null;
  isFullProject: boolean; // 空选择器 = 全量（UI 显著标注）
}

// RunItemInfo 增：
//   env: string | null            —— 该条目执行所用环境（上下文名；NULL = 无环境）
// RunInfo 增：
//   envs: string[]                —— 本次 run 涉及的全部环境（去重；无环境时为 []）
```

---

## 3. 解析模型

### 3.1 单测试集解析（唯一实现：`resolveSuiteSelector`）

从 `createRun` 现有 WHERE 构造中**抽出共享函数**（`apps/server/src/selector.ts`，供 createRun / suite 解析 / 预览 / schedule 复用）：

```
resolveSuiteSelector(projectId, selector, { includeQuarantinedOverride? }):
  1. 基准集：
     selector 存在任一筛选维度（tags/excludeTags/version/module/q）或 includeCaseIds 非空
       → 筛选 SQL 命中（沿既有 WHERE：project 约束 + status='active' + tag EXISTS/NOT EXISTS …）
     否则 → 该项目全部 active 用例（D4，isFullProject=true）
  2. 并入：includeCaseIds（按 id 逐条查 active；不存在的静默跳过并计入 danglingIncludes）
  3. 扣除：excludeCaseIds（对 2 的结果做差集——D3 排除优先，压过筛选与显式包含）
  4. 隔离：默认剔除 quarantined（includeQuarantinedOverride ?? selector.includeQuarantined ?? false）
  5. 返回 { ids（ORDER BY c.id 确定性排序）, quarantinedExcluded, danglingIncludes, deadEntries }
```

要点：

- 解析**总是现读当前用例库**——新 push 的用例打上 tag 下一次引用即生效；
- `deleted / invalid / disabled` 用例一律不解析进来（沿 createRun 的 `status='active'`）；
- danglingIncludes 是**警示不是错误**：用例随 git 生灭是常态，集不该因此坏掉；健康度（SuiteHealth）负责让人看见。

### 3.2 多测试集合并：环境上下文与「用例 × 环境」去重（核心）

`CreateRunPayload` 增 `suites?: string[]`（名字引用，项目内唯一）。创建流程：

```
1. 逐个校验：存在（404 SUITE_NOT_FOUND）、enabled（400 SUITE_DISABLED）、project 一致
   （400 SUITE_PROJECT_MISMATCH，列出冲突集名）
2. 逐个解析（§3.1）→ 有集解析为 0 条 → 400 SUITE_RESOLVED_EMPTY（点名是哪个集，
   并附其 selector 摘要，Agent 可立即自诊）
3. 归并环境上下文（env context）：
   - run 显式传了 env（payload.env）→ 覆盖拉平：所有来源（测试集/直接选择器）都归入
     该环境的单一上下文，测试集自身的 env 绑定被忽略（scope 快照记录"已被 run 显式覆盖"）
   - 否则：每个测试集按自己的 env 归入上下文（同名环境 = 同一上下文）；
     无 env 绑定的测试集与「直接指定范围」（筛选/caseIds）共同归入隐式上下文（无环境）
4. 上下文内一致性（D6）：
   同一上下文的多个来源集，account 不同 / params 同键不同值 → 400 SUITE_ACCOUNT_CONFLICT /
   SUITE_PARAM_CONFLICT（列出上下文、来源集与冲突键），run 显式给出该值（params.AUTH_ACCOUNT
   或对应 param 键）则不算冲突；跨上下文天然无冲突
5. 生成执行条目（去重键 = caseId × 上下文）：
   entries = ⋃ 各测试集 (其命中用例 × 其上下文) ∪ 直接选择器命中 (× 隐式上下文)
   同 (case, context) 只保留一条（多个集贡献时取首个来源，scope 快照记录来源集列表）
6. 排除参数（excludeTags / 各集 excludeCaseIds）在各自解析阶段已生效；
   空结果 → 既有 NO_CASES_MATCHED；随后走 createRun 既有链路（资产/auth 校验 → 快照）
```

去重与矩阵语义（对齐 Playwright 多 project）：

| 场景                                                          | 结果                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 用例 X 在集 A（env dev）与集 B（env dev）                     | **执行 1 次**（dev；scope 记录来源 A、B）                                                       |
| 用例 X 在集 A（env dev）与集 B（env staging）                 | **执行 2 次**（dev 一次、staging 一次，各自统计与产物）                                         |
| 用例 X 在集 A（env dev）+ run 直接 caseIds 点名               | 执行 1 次（隐式上下文与 dev 不同，但隐式上下文无 BASE_URL 等 → 视需求；通常应避免混用，见防呆） |
| run 显式 `env=staging` + 集 A（env dev）、集 B（env staging） | 全部拉平进 staging，**各执行 1 次**（D9 覆盖模式，退化为 v0.5 行为）                            |

排序：`batch_items.position` 按「测试集引用顺序 → 集内 caseId 字典序 → 直接选择器条目」。平台本就不保证执行顺序（用例独立性），position 只影响展示。

### 3.3 执行前提（env / account / params）分层

**创建时**（写进各上下文行，run 内不变）：

```
上下文.params = 环境值（F1 展开非 secret 部分） ← 来源测试集 params 覆盖（同键取集值；
                同上下文多集同键不同值 → 400，见 §3.2 第 4 步）
上下文.account = 来源测试集 account（同上下文须一致 / run 显式 AUTH_ACCOUNT 覆盖）
                → 写为上下文 params.AUTH_ACCOUNT
上下文.secret = 环境值中清单 secret: true 的键（AES-GCM 密文，同 F1）
上下文.device_proxy = 环境级设备代理模式快照（F9，随环境走）
```

**下发时**（assign，逐条目合并，见 §5）：

```
task.params = { ...上下文.params, ...batches.params（run 级显式，最高）,
                ...decrypt(上下文.params_secret), ...decrypt(batches.params_secret) }
```

进入既有链路后语义不变：

- 每个引用到的环境都走 F1 完备性校验，缺齐 → 创建即 400 `MISSING_ENV_VALUES`（错误信息按环境分组列出缺失键，fail-fast）；
- `AUTH_ACCOUNT` 沿 auth-design 语义：**只覆盖未声明 frontmatter `auth` 的用例**（显式声明 `auth: admin` / `auth: none` 的用例不受影响）——文档与 UI 提示都要写清；多环境下，同一用例在 dev 上下文以 default 跑、在 staging 上下文以 admin 跑是完全合法的（上下文各写各的 AUTH_ACCOUNT）；
- 集级 `account` 在**保存时**对照当前 auth 快照（`projects.auth`，sync 时镜像）只警示（仓库可能随后补上），**run 创建时**未知账号 → 400 `AUTH_ACCOUNT_NOT_FOUND`。

### 3.4 预览（dry-run，不落库）

- `POST /api/v1/projects/:idOrName/suites/preview`：body = 草稿（selector + env/account），返回 SuiteHealth + 命中用例（`limit` 控制条数）——编辑器实时预览用；
- `POST /api/v1/runs/preview`：body = 完整 CreateRunPayload（含 suites 与显式选择器），返回：

```json
{
  "total": 34,
  "contexts": [
    { "env": "dev", "sources": ["smoke", "ocr-full"], "caseCount": 22 },
    { "env": "staging", "sources": ["regression"], "caseCount": 12 }
  ],
  "perSuite": [{ "name": "smoke", "resolvedCount": 12 }],
  "deduped": [{ "caseId": "portal/auth/session-admin", "kept": "dev", "droppedFrom": ["smoke"] }],
  "quarantinedExcluded": 2
}
```

——发起运行对话框的合计预览，也是 Agent 发起前的自查入口。两个预览与正式解析共用 `resolveSuiteSelector` 与上下文归并逻辑，保证所见即所得。

---

## 4. API 设计

沿用既有约定（JSON、`{error:{code,message}}`、分页）。测试集按**项目内名字**寻址（与 environments 一致：名字对人和 Agent 友好；run 侧靠快照免疫后续改名）。

| Method | Path                                        | 说明                                                                                       |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/projects/:idOrName/suites`         | 列表（含 health 现算；`?q=` 按名/描述过滤）                                                |
| POST   | `/api/v1/projects/:idOrName/suites`         | 创建（name/selector 校验；env/account 存在性软校验）                                       |
| GET    | `/api/v1/projects/:idOrName/suites/:name`   | 详情 + health + 命中用例首页（`?limit=`）                                                  |
| PATCH  | `/api/v1/projects/:idOrName/suites/:name`   | 更新（含改名；改名会同步重写本项目 schedules.scope 里引用的旧名，§8）                      |
| DELETE | `/api/v1/projects/:idOrName/suites/:name`   | 删除（历史 run 靠快照不受影响；引用它的 schedule 触发时报 SUITE_NOT_FOUND 走既有告警路径） |
| POST   | `/api/v1/projects/:idOrName/suites/preview` | 草稿解析预览（§3.4）                                                                       |
| POST   | `/api/v1/runs/preview`                      | run 创建 dry-run 预览（§3.4，含上下文与去重明细）                                          |

**CreateRunPayload / RunInfo 变更：**

```ts
// CreateRunPayload 增：
suites?: string[];            // 引用的测试集名（与 project 一致；与筛选/caseIds 并存，并集语义）
// 语义提醒：payload.env 存在时为「全局覆盖/拉平」（D9）；不传时各集用自己的 env

// RunInfo 增：
suites: string[];             // 引用过的集名快照（scope JSON 派生）
envs: string[];               // 本次 run 涉及的环境（多环境矩阵时 >1）
// RunItemInfo 增：env: string | null（该条目的执行环境）
// RunQuery 增：suite?: string（GET /runs?suite=smoke，json_each 匹配 scope.suites[].name）
//              既有 env 筛选扩展为「匹配任一上下文环境」（join run_envs）
```

**run scope 快照示例（审计核心）：**

```json
{
  "project": "portal",
  "suites": [
    { "id": "ts_01JB…", "name": "smoke",      "resolvedCount": 12, "env": "dev",
      "selector": { "tags": ["smoke"], "excludeCaseIds": ["portal/task/rename-delete"] } },
    { "id": "ts_01JC…", "name": "regression", "resolvedCount": 12, "env": "staging",
      "selector": { "tags": ["api", "ui"], "tagMode": "any" }, "account": "admin" }
  ],
  "envContexts": [
    { "env": "dev",     "sources": ["smoke"],      "caseCount": 12 },
    { "env": "staging", "sources": ["regression"], "caseCount": 12, "account": "admin" }
  ],
  "envOverridden": false,
  "deduped": [],
  "tags": [], "caseIds": [], "excludedQuarantined": 2,
  "assets": { … }, "auth": { … }
}
```

**错误码汇总：** `SUITE_NOT_FOUND`(404)、`SUITE_NAME_TAKEN`(400)、`INVALID_SUITE_SELECTOR`(400，未知键/类型错)、`SUITE_PROJECT_MISMATCH`(400)、`SUITE_DISABLED`(400)、`SUITE_RESOLVED_EMPTY`(400)、`SUITE_ACCOUNT_CONFLICT` / `SUITE_PARAM_CONFLICT`(400，**仅同一环境上下文内**触发，见 §3.2)、`AUTH_ACCOUNT_NOT_FOUND`(400)。env 相关沿用 F1 的 `ENV_NOT_FOUND` / `MISSING_ENV_VALUES`。~~v1 稿的 `SUITE_ENV_CONFLICT` 取消~~——多环境并存即本版语义。

---

## 5. 执行链路适配（调度 / 下发 / 重跑）

worker 协议**零改动**：assign 本来就是逐任务组装 `params`（runtime.ts `assignRun`），任务天然可携带各自参数。改动全在 server：

| 位置                         | 改动                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignRun`                  | 组装 params 时：`item.run_env_id` 非空 → 读对应 `run_envs` 行（params + 解密 params_secret）作为基底，再叠加 `batches.params / params_secret`（run 级显式覆盖）；NULL → 维持现状（batch 级）。`deviceProxy` 改读条目上下文（NULL 回落 batch，历史 run 兼容）            |
| `resolveCaseAuth`            | `AUTH_ACCOUNT` 从合并后的任务参数取（现状只读 batch.params）——多环境下同一用例在不同上下文可用不同账号                                                                                                                                                                  |
| `rerunRun` / retry-failed    | 从源 run 取**（case_id, run_env_id）对**重建，而非 case_id 去重清单——失败条目在哪个环境失败的，就在哪个环境重跑；上下文的环境已被删除 → 该上下文回退隐式（沿用"环境被删不阻塞重跑"的既有策略）；内部走「条目对 + 上下文复制」的创建路径（不经公共 payload 的 env 展开） |
| `recomputeRun` / 统计        | 不变：total = 条目数（含同用例多环境的多条），passed/failed 按条目统计                                                                                                                                                                                                  |
| `runPublic` / getRun         | 返回 `envs[]`、每 item 带 `env`；`params` 展示 run 级显式参数（上下文参数在条目环境里看）                                                                                                                                                                               |
| batch-report.json / 钉钉通知 | 每条结果增 `env` 字段；通知摘要列出涉及环境与各自通过率（如 `dev 12/12 ✓ · staging 9/12 ✗`）                                                                                                                                                                            |
| WS 事件 / 实时进度           | `item.updated` payload 增 `env`；运行详情页行级 env 徽标                                                                                                                                                                                                                |

---

## 6. SDK / CLI / MCP

### 6.1 CLI（packages/cli）

```
tern suites <project> list [--json]                       # 含命中数与健康徽标
tern suites <project> show <name> [--json]
tern suites <project> create <name> [--desc …]
      [--tag smoke …] [--tag-mode any|all] [--exclude-tag …]
      [--module …] [--version …] [--q …]
      [--include caseId1,caseId2] [--exclude caseId…]
      [--env staging] [--account admin] [--param K=V]…
tern suites <project> update <name> […同上字段，提供才改] [--rename newName]
tern suites <project> rm <name>
tern suites <project> preview [选择器参数同 create]        # 不落库看命中
tern run --project p --suite smoke --suite regression …    # 可重复 --suite（各用各的 env）；与 --tag/--case 并存
tern run --project p --suite smoke --env staging …         # 显式 --env = 全局覆盖拉平（"换环境打这个集"）
tern runs list --suite smoke [--env dev]                   # 按集/环境筛历史运行
```

### 6.2 MCP（apps/mcp）

| 工具                                                            | 说明                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `tern_list_suites`                                              | 入参 project；返回名称/描述/命中数/health/env/account——Agent 选集的主入口 |
| `tern_get_suite`                                                | 详情 + selector + 命中用例清单                                            |
| `tern_create_suite` / `tern_update_suite` / `tern_delete_suite` | 完整管理（Agent 可自助建集）                                              |
| `tern_run_cases` 增 `suites?: string[]`                         | 与既有 version/tags/caseIds 并存；不传 `env` 即各集自带环境               |
| `tern_preview_run`                                              | dry-run 入口（§3.4，含上下文与去重明细），Agent 发起前自查                |

典型 Agent 工作流：

```
1. tern_list_suites(project="portal")                  # smoke→dev(12 条)、regression→staging(12 条)
2. tern_run_cases(project="portal", suites=["smoke","regression"], wait=true)
   # 一次 run：dev 冒烟 + staging 回归，重叠用例各自环境各跑一次
3. 失败 → tern_get_failure_summary（每条带 env）/ tern_retry_failed（按原环境重跑）
```

---

## 7. Web 管理端

| 位置                            | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/suites`（一级导航「测试集」） | 顶部导航独立页：项目下拉（仅一个项目时自动选中）+ 集卡片列表（名称、描述、命中数、`env:dev` / `账号:admin` 徽标、健康徽标：空集/悬空引用/环境缺值/全量警示）；新建/编辑对话框 = 选择器构建器（tags any/all + 排除、version/module 多选、q、include/exclude 用例多选）+ env 下拉（不完备提示缺失键）+ 账号输入 + params 键值对 + **实时命中预览**（调 preview，显示条数与首屏用例）；每集可「发起运行」（带预选跳转运行对话框）。项目页行内保留「测试集」快捷入口（跳转 `/suites/<项目>`） |
| 发起运行对话框                  | 顶部「测试集」多选 chips（显示各自命中数 **与环境徽标**）；合计预览按环境分组（`dev 22 · staging 12`）；显式选择「覆盖环境」下拉（默认"各测试集自带环境"，选中具体环境即拉平模式）；与既有筛选/caseIds 并存                                                                                                                                                                                                                                                                               |
| RunDetailPage                   | 概要卡显示集 chips + 环境列表；items 表每行 env 徽标（可按 env 分组/过滤）；统计卡可按环境分列                                                                                                                                                                                                                                                                                                                                                                                            |
| SchedulesPage                   | 创建/编辑对话框增测试集多选（与 raw scope 互斥展示：选了集即隐藏筛选区，避免双份心智）                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 8. 定时任务集成

- `SCOPE_KEYS` 白名单增 `suites`（schedules.ts 单行改动）；`fireDueSchedules` 现有 `...scope` 展开自然把它带进 `CreateRunPayload.suites`；
- env 层级：`schedule.env`（显式，拉平全部）> 各测试集自带 env（§3.2 规则照常生效）——"每晚 dev+staging 双环境回归"与"每晚固定打 staging"两种诉求都覆盖；
- **改名联动**：suite PATCH 改名时，应用层重写本项目所有 `schedules.scope.suites` 中的旧名（行数少，直接 JSON 改写），消除"改名打断夜间任务"的坑；
- 集被删除/停用：schedule 触发时 createRun 抛 SUITE_NOT_FOUND/SUITE_DISABLED → 走既有失败路径（system.alert + next_run_at 前进，不会每 15s 风暴重试）。

---

## 9. 校验与防呆汇总

| 时机        | 校验                                                                                                              | 行为                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 保存集      | name kebab-case、项目内唯一；selector 键白名单与类型（INVALID_SUITE_SELECTOR）；include/exclude 跨项目 ID         | 跨项目 ID → 400（集只装本项目的用例）；本项目但当前不存在的 ID → 接受，health.danglingIncludes 警示                        |
| 保存集      | env / account 存在性                                                                                              | 软校验：env 不存在 → 接受 + health.envStatus='missing'；账号不在 auth 快照 → 接受 + accountKnown=false（仓库可能随后补上） |
| 读列表/详情 | health 现算                                                                                                       | 空集（resolvedCount=0）、全量（isFullProject）、死条目、隔离排除数、环境缺值                                               |
| run 创建    | 集存在/启用/同项目/非空解析；**每个引用到的环境**走 F1 完备性校验；同上下文 account/params 一致性；account 可解析 | 全部 fail-fast 400，错误信息点名集名/环境/冲突明细                                                                         |
| run 创建    | 测试集条目与「直接指定范围」混用                                                                                  | 允许但预览显著提示：直接范围落在无环境的隐式上下文（多半忘了选环境），预览的 contexts 明细让用户一眼看出                   |
| run 创建后  | scope 快照（含各集 selector、上下文构成与去重记录）                                                               | 之后仓库/集/环境怎么变都不影响本次 run 的构成、参数与审计                                                                  |

---

## 10. 用例级环境/账号依赖（配套扩展，本期不做）

诉求背景：某些用例天然只在特定环境可跑（如依赖后端 `mock.login=true` 的登录后门用例、只在国内站存在的功能）。测试集级绑定解决"一组用例配一个环境"；多集多环境（v2）进一步让"同一批用例跨环境各跑一次"。若要精确到**单条用例**的条件依赖，扩展方案草案：

- frontmatter 增 `requiresEnv: [dev]`（或 `requires: { envAny: [dev], account: admin }`）；
- run 解析时对照条目所属上下文的环境：不满足 → 该 item 直接置 `skipped`，last_error 记 `环境不满足 requiresEnv=dev（当前=staging）`——沿用"条件跳过"而非报错的成熟语义（pytest skipif）；
- sync 期 lint 校验引用的账号存在。

放在未来的原因：需要定义"环境特征"的表达方式（env 名 vs 特征变量，后者更通用，如 tern.yaml `env.features: { mockLogin: true }`），值得单独立项设计；且"按环境拆集 + 多集并跑"已能覆盖当前主要痛点。

---

## 11. 测试与验收

| 层               | 内容                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单测（server）   | `selector.test.ts`：解析矩阵（筛选/空选择器=全量/include 并入/exclude 压过一切/隔离默认排除与纳入/dangling 跳过/确定性排序）；**上下文归并**（同环境合并、无环境隐式上下文、run.env 拉平）；**（case × env）去重矩阵**（同环境去重保序、跨环境并存、同上下文 account/params 冲突 400）；run_envs 落库与快照；改名联动 schedules；suites CRUD 与校验 |
| 单测（既有回归） | createRun 抽函数重构后全量既有测试不回归（不传 suites 的路径行为等价：单环境写 batches、run_env_id=NULL）                                                                                                                                                                                                                                           |
| 执行链路         | assignRun 按条目上下文组装 params（多环境各自 BASE_URL/AUTH_ACCOUNT 正确下发）；rerunRun 保留 (case, env) 对，失败环境原位重跑                                                                                                                                                                                                                      |
| API/e2e          | tests/fixtures demo 项目建集 → 两集两环境 run 断言条目构成/去重/上下文参数 → 同上下文冲突 400 → schedule 引用双环境集夜间触发 → 集改名后 schedule 名字已联动                                                                                                                                                                                        |
| Dogfood          | 真实业务项目实建：`smoke`（tags:smoke + 核心链路点名，env:dev）、`order-full`（module:order，env:dev）、`regression`（tags:api+ui，env:staging）；日常回归一次 run 双环境                                                                                                                                                                           |

验收标准：Agent 仅凭 `tern_list_suites` + `tern_run_cases(suites=[…])` 完成一次**多环境**回归（dev 冒烟 + staging 回归），重叠用例各环境各执行一次、失败按原环境重跑，全程不需要知道 tags 组合或凭据配在哪里。

---

## 12. 实施切分

| 里程碑                  | 内容                                                                                                                                                                                                                | 涉及模块    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| M1 后端核心             | selector 抽取重构、suites 表 + CRUD + 解析/预览、**run_envs + batch_items.run_env_id、createRun 上下文归并与 (case×env) 去重**、assignRun/rerunRun 适配、schedules 集成、runs?suite=/env 筛选 + 单测                | server、sdk |
| M2 CLI                  | `suites` 命令组、`run --suite`、`runs list --suite/--env`                                                                                                                                                           | cli         |
| M3 Web                  | 项目详情测试集区 + 编辑器、运行对话框（按环境分组合计预览 + 覆盖环境开关）、run 详情 env 徽标与分组、schedule 对话框                                                                                                | web         |
| M4 MCP + 文档 + dogfood | 5 个 suite 工具 + tern_run_cases 扩展；AGENTS.md、skills/tern-project 增 `references/test-suites.md`（建集指南：什么该成集——稳定口径、环境/账号成组；什么不该——一次性排查；多环境并跑的语义说明）；业务项目实建三集 | mcp、skills |

## 13. 非目标

- 测试集嵌套引用（集引集）与跨项目测试集/测试计划（plan）层——组合爆炸，等真实需求；
- **同环境内的参数变体矩阵**（同 env 不同参数各跑一次）——去重键固定为「用例 × 环境」，同环境内一个用例只有一种参数/账号形态（冲突即 400）；变体矩阵对应 tech-design 早已预留的 `variants` 方向，单独立项；
- 集的版本化、审批流、按集权限；
- 集内用例顺序/依赖保证（平台用例独立性原则不动摇）；
- 保存时物化用例清单的"冻结集"模式——纯 includeCaseIds 已可表达，无需独立模式；
- 用例级 requiresEnv/requires（§10，单独立项）。
