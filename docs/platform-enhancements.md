# Tern 平台增强技术方案（P0 / P1 + Run 删除）

> 状态：设计稿（待评审）。范围：环境管理、run 删除、trace 在线查看、失败摘要、flaky 治理、定时任务、钉钉通知。
> 原则：不引入消息队列/Redis 等外部依赖；沿用 SQLite 单文件 + 事件总线 + WS 的既有架构；所有新能力对 CLI / API / MCP / Web 四端一致。

## 0. 总览

| #   | 功能                                              | 优先级 | 核心改动                                                                                                                    |
| --- | ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| F1  | 环境管理（yaml 声明变量清单 + 平台定义环境/存值） | P0     | tern.yaml 增 `env.variables` 清单节点；平台 `environments` 表存各环境值（加密）；`batches` 增 env 列 + 加密 `params_secret` |
| F2  | Run 删除（含产物文件清理）                        | P0     | `DELETE /api/v1/runs/:id`；级联删 DB 行 + `data/artifacts/<batchId>/`                                                       |
| F3  | Trace 在线查看                                    | P0     | 自托管 Playwright trace viewer；详情页 trace 链接改为 viewer                                                                |
| F4  | 失败摘要（聚类 + 跨 run 历史）                    | P0     | `case_runs.error_sig`；`GET /runs/:id/failure-summary`；MCP `tern_get_failure_summary`                                      |
| F5  | Flaky 治理（统计 + 自动隔离）                     | P1     | 新表 `case_stats`；`cases.quarantined`；createRun 默认排除                                                                  |
| F6  | 定时任务                                          | P1     | 新表 `schedules`；内置 5 字段 cron 解析；server 调度循环                                                                    |
| F7  | 钉钉机器人通知                                    | P1     | 新表 `webhooks`；run 终态触发 markdown 消息（支持加签）                                                                     |

一次 migration（id=7）承载全部 schema 变更。涉及模块：`apps/server`（主要）、`packages/sdk`（类型+client）、`apps/mcp`、`packages/cli`、`apps/web`。

---

## F1. 环境管理

### 1.1 动机与决策

- 现状：运行参数是每次 run 手拼的自由 `Record<string,string>`，明文存 `batches.params`，无环境概念。
- **清单在仓库、值在平台**：tern.yaml 用专门节点声明本项目需要的**变量清单**（变量名、说明、是否敏感）——这是用例作者/Agent 唯一知道的部分；**有哪些环境、每个环境的值**由平台侧定义并存储（运营数据，不该锁进 git）。与行业实践一致：GitHub Actions / CI/CD pipelines 都是「workflow 文件声明需要哪些变量，平台 UI 按环境存值」，K8s 是「manifest 声明 env 名、ConfigMap/Secret 供值」。
- 收益：新增环境不需要 git 提交（运营动作快）；平台按清单校验环境值完备性，UI 能明确显示「staging 缺 CLIENT_ID」；Agent 脚手架用例项目时自然产出变量契约；secret 与否由清单声明，凭据仍然不进 git。
- **值全部加密落库**：环境值统一 AES-256-GCM 加密存储；清单中 `secret: false` 的变量在 API 回显（便于排障），`secret: true` 的永不回显。运行时展开后的 secret 值加密存 `batches.params_secret`，仅在给 worker 下发任务时解密——现有明文 `params` 的凭据问题由此收敛。
- `BASE_URL` 降级为普通清单变量（保留其特殊运行时语义：映射为 playwright baseURL），不再单独设 baseUrl 字段。
- **fail-fast**：环境值不满足清单（缺必填键）时，run **创建时**即报 400 并列出缺失变量名（现状是执行期 AuthError 才暴露）。

### 1.2 tern.yaml 变量清单节点

```yaml
# tern.yaml
name: portal
env: # 变量清单（契约）：本项目运行需要哪些变量
  variables: # 缺省整个 env 节点 = 无契约（完全向后兼容）
    BASE_URL:
      description: 被测前端地址（/api 由其代理到后端）
    CLIENT_ID:
      description: default 账号 clientId（mock-login 凭据）
      secret: true # 缺省 false；true = 平台加密存储且不回显
    ADMIN_CLIENT_ID:
      description: admin 账号 clientId
      secret: true
```

- 变量名约束 `[A-Z][A-Z0-9_]*`（sync 校验）；map 形式天然防重；`description` 供平台 UI 展示。
- sync 防呆：变量名含 `TOKEN/SECRET/PASS/KEY/CREDENTIAL` 而未标 `secret: true` → sync 报告警告。
- 无 `env` 节点的项目：环境值集不受清单校验（同时充当「命名参数预设」使用，值一律按敏感处理）。

### 1.3 数据模型（migration 7 片段）

```sql
-- 变量清单镜像（来源 tern.yaml，随 sync 覆盖，只读）
CREATE TABLE env_variables (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  secret INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, key)
);

-- 环境（平台侧定义；值整体加密存一列，回显策略由清单驱动，免清单变更时的重分装）
CREATE TABLE environments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,                    -- 项目内唯一，小写 kebab-case（dev/staging/prod…）
  description TEXT NOT NULL DEFAULT '',
  values_enc TEXT NOT NULL DEFAULT '{}', -- AES-256-GCM 密文 JSON {KEY: value}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

ALTER TABLE batches ADD COLUMN env_name TEXT;       -- 快照用的环境名
ALTER TABLE batches ADD COLUMN params_secret TEXT;  -- AES-256-GCM 密文 JSON {key:value}
```

- project 删除时级联清理 env_variables / environments（沿用现有 children 清理模式）。
- 清单变更：删除变量导致某些环境残留无效值 → sync 报告提示 + UI 提供清理；`secret` 标志翻转即时影响回显（存储不变）。

### 1.4 密钥加密

- 新增 `apps/server/src/crypto.ts`：`encryptJson(obj) / decryptJson(str)`，AES-256-GCM，密文格式 `v1:<iv b64>:<tag b64>:<data b64>`；同时用于 environments.values_enc 与 batches.params_secret。
- 密钥来源：环境变量 `TERN_SECRET_KEY`（hex/base64，32B）；未设置则自动生成并写入 `data/.secret-key`（0600，与 `.worker-token` 同模式）。密钥丢失 = 历史密文不可解（run 已结束则无影响；排队中 run 的 secret 参数失效，重跑即可）——文档明示，本期不做密钥轮换。
- 访问纪律：解密只发生在三处——环境 CRUD 保存/校验、createRun 展开、`assignRun()` 组装 worker 任务；`runPublic()` / getRun 返回 params 时按清单/来源规则脱敏（清单 `secret: true` 或无清单来源 → `***`）；`writeBatchReport()` 输出前剔除 `params_secret`；events 不携带参数值。

### 1.5 参数展开分层（createRun 改动）

```
env 展开：decrypt(environments.values_enc) → 得到 {KEY: value}
完整性校验（有清单时）：清单所有 key 必须有值，缺失 → 400 MISSING_ENV_VALUES（聚合列出缺失键，fail-fast）
层叠顺序：payload.params（显式，最高） > 环境值 > （无则维持现状）
分装：清单 secret: true 的键值 → params_secret（加密）；secret: false → params（明文）；
     无清单项目的环境值 → 一律 params_secret（fail-closed）；payload.params 直传部分维持现状明文
BASE_URL：payload.params.BASE_URL > 环境值.BASE_URL > 无（auth 相对地址时 worker 报 AuthError，维持现状）
下发 worker：assignRun 合并 params + decrypt(params_secret) 为 task.params（对 worker 协议零改动）
```

- `CreateRunPayload` 增加：`env?: string`（环境名）。
- 校验：`env` 不存在 → 400 `ENV_NOT_FOUND`；显式 `payload.params` 覆盖环境值时按其原明文语义处理（可用 `secretParams: string[]` 标记敏感，维持上一稿设计）。
- 兼容：不传 `env`、只传 `params` 的旧调用完全不变；tern.yaml 无 `env:` 节点的项目完全不变。

### 1.6 API / SDK / MCP / CLI / Web

| 端  | 新增                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API | `GET /api/v1/projects/:name/env-variables`（清单，来自 sync）；`GET/POST /api/v1/projects/:name/environments`（列出/创建，含完备性计算）；`PATCH .../environments/:envName`（改名/描述/整体替换值）；`DELETE .../environments/:envName`。值写入时按清单校验未知键；GET 回显时 secret 键只返回 `{configured: true}` 不回值 |
| SDK | `EnvVariable` / `Environment` 类型 + client 对应方法；`RunInfo` 增 `envName`、`params`（脱敏后）                                                                                                                                                                                                                          |
| MCP | `tern_list_environments`（各环境值完备性 + 缺失键清单，Agent 可自查能否发起运行）；`tern_run_cases` 增 `env` 入参                                                                                                                                                                                                         |
| CLI | `tern env list/create/set/rm <project> <env> ...`（`--set KEY=V`，secret 值用 `--set-secret KEY=V` 或 `--from-env KEY`）；`tern run --env staging`；`tern runs list --env` 筛选                                                                                                                                           |
| Web | ProjectsPage 项目详情：「变量清单」区（只读，来自仓库，展示名称/说明/敏感标记）+「环境」区（卡片式：值表单按清单生成输入项，secret 用密码框保存后掩码，完备性徽标）；RunsPage 增环境列 + 筛选；RunDetailPage 头部显示环境；发起运行对话框增环境下拉（不完备的环境置灰并提示缺失键）                                       |

---

## F2. Run 删除

### 2.1 规则

- 允许删除终态 run（status ∈ completed / cancelled；pending / running 拒绝，`force=true` 时先 `cancelRun(force)` 等终态再删）。
- 一个事务内级联（按序，配合 SQLite 现有外键风格）：
  1. `DELETE FROM events WHERE topic = 'run:<batchId>'`，以及该 run 全部 `execution:<caseRunId>` topic（先收集 id，`IN` 分批 500/批；persisted 事件每执行仅 2 条，量可控）；
  2. `DELETE FROM case_runs WHERE batch_id = ?`（大 run 千级，按 500 行分块提交，避免长事务卡调度 tick）；
  3. `DELETE FROM batch_items WHERE batch_id = ?`；
  4. `DELETE FROM batches WHERE id = ?`。
- 事务提交后异步 `rm -rf data/artifacts/<batchId>/`（截图/trace/视频/run.log/events.jsonl/batch-report.json 全在其中），失败仅告警不回滚。
- `schedules.last_run_id` 指向被删 run：不级联清空（保留 id 字符串，列表页对无效 id 显示「已删除」）。
- 与现有保留策略关系：每小时产物清理（`ARTIFACT_RETENTION_DAYS`）行为不变（只删文件不删行）；手动删除是补齐的另一半。

### 2.2 各端

API `DELETE /api/v1/runs/:id?force=` → `{deleted, removedExecutions}`；SDK `deleteRun`；MCP `tern_delete_run`；CLI `tern runs delete <id> [--force]`；Web RunsPage 行内删除（confirm 二次确认）。

---

## F3. Trace 在线查看

### 3.1 方案：自托管 trace viewer

- Playwright npm 包内含其官方 trace viewer SPA（`npx playwright show-trace` 所服务的即是）。
- 部署期提取：`scripts/docker-build.sh` 在 server 镜像构建时从安装的 `playwright` 包内定位 viewer 静态资源目录（构建脚本探测安装版本的实际路径；同时支持环境变量 `TRACE_VIEWER_DIR` 显式指定，本地开发 `pnpm install` 后由 server 启动时兜底探测），拷贝为 server 镜像内 `/app/trace-viewer/`。
- server：`@fastify/static` 挂载 `/trace-viewer/*`（与 `/artifacts` 同安全模型）。
- 链接生成：RunDetailPage 与 API 的 `artifacts.trace` 旁新增 `traceViewerUrl = /trace-viewer/index.html?trace-url=/artifacts/<batchId>/<runId>/trace.zip`。同源加载，无 CORS 问题。
- **版本兼容**：viewer 版本必须与 worker 镜像的 Playwright 大版本一致（当前 v1.59，见 `.env.example` 的 `PLAYWRIGHT_IMAGE`），提取脚本从 server 侧锁版本的 `playwright` 包取，升级 worker 版本时同步升级。不匹配时 viewer 通常向后兼容小版本，大版本差异在发布说明中提示。
- 探测失败（资源缺失）时回退为现状的 zip 下载链接，不影响其他功能。

---

## F4. 失败摘要（聚类 + 跨 run 历史）

### 4.1 错误签名

- `case_runs` 增列 `error_sig TEXT` + 索引 `idx_case_runs_sig`。
- server 在 `handleResult` 落库时计算（worker 零改动）：取 `error.message` 首行 → 去首尾空白 → 压缩连续空白 → 小写 → 数字/UUID/时长归一为 `#` → 截断 160 → sha1 hex。空 message（如 lost）用 `status:` 前缀兜底。
- 归一化规则集中在 `error-sig.ts` 纯函数，单测覆盖（路径数字、超时毫秒数、UUID）。

### 4.2 摘要 API 与消费

- `GET /api/v1/runs/:id/failure-summary`：

```jsonc
{
  "groups": [
    {
      "sig": "sha1…",
      "label": "timeout 30000ms exceeded",
      "count": 3,
      "items": [
        {
          "caseId": "portal/smoke/app-loads",
          "executionId": "…",
          "status": "timed_out",
          "durationMs": 30120,
          "screenshotUrl": "/artifacts/…",
          "traceViewerUrl": "/trace-viewer/…",
          "logTail": ["…最近 20 行…"],
        },
      ],
      "history": { "occurrenceRuns": 7, "firstSeenAt": "…", "lastSeenAt": "…" }, // 跨 run 同签名统计（全表按 sig 查）
    },
  ],
}
```

- 计算：本 run 内 `GROUP BY error_sig`（status ∈ failed/timed_out/error）；history 用同 sig 全表聚合。全部为已有表上的 SQL，无需新表。
- MCP 新工具 `tern_get_failure_summary(runId)`：返回上述 JSON（text）；当 `withScreenshot=true`（缺省 true）时附第一组首张截图为 image content——Agent 一步拿到「同类失败分组 + 现场图」。
- Web：RunDetailPage 增「失败分组」视图（按组折叠，组内列用例/耗时/截图缩略图/trace viewer 链接），与现有逐条列表并存切换。

---

## F5. Flaky 治理

### 5.1 口径与数据

- 新表 `case_stats`（滚动窗口物化，避免列表页实时聚合）：

```sql
CREATE TABLE case_stats (
  case_id TEXT PRIMARY KEY REFERENCES cases(id),
  total INTEGER NOT NULL DEFAULT 0,      -- 窗口内终态执行次数
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  flaky INTEGER NOT NULL DEFAULT 0,      -- 判定为 flaky 的次数
  history TEXT NOT NULL DEFAULT '[]',    -- 滚动序列，如 ["p","F","f","f","p"]，F=flaky-pass，上限 50
  updated_at TEXT NOT NULL
);
```

- **flaky 判定（合并两个来源）**：① 现有 `case_runs.flaky=1`（runner 内重试后通过）；② run 级重试后通过：`batch_items.attempt>1 且终态 passed`（`handleResult` 终态分支判断，attempt 已在内存对象上）。
- 更新点：`handleResult` item 终态时 `updateCaseStats(caseId, outcome)`（滚动 push + 截断 50，同步增减计数用重放 history 计算，保证窗口语义一致）。

### 5.2 自动隔离（quarantine）

- `cases` 增列 `quarantined INTEGER NOT NULL DEFAULT 0`。
- 规则（`updateCaseStats` 内评估）：`total ≥ 10 且 flaky/total ≥ 0.3`（阈值 `FLAKY_QUARANTINE_THRESHOLD` 可配）→ 自动置 1 并 emit `system.alert`（含 caseId 与比率）；`最近 10 次全 passed` → 自动解除（同样告警）。手动开关优先级高于自动（手动设置的 24h 内不被自动规则翻转，用 `cases.quarantined_manual_at` 记录，简化实现：手动操作直接写 history 不可行——采用 `quarantined_by TEXT`（'auto'|'manual'|'auto-recovered'），auto 规则不覆盖 manual）。
- **createRun 默认排除** quarantined 用例（WHERE 追加 `c.quarantined=0`），`payload.includeQuarantined=true` 才纳入；命中的隔离用例被排除时在 run 创建响应中提示数量（不静默）。显式 `caseIds` 点名的用例**不受排除**（点名即意图）。
- 各端：CasesPage 增 flaky 率列 + 隔离徽标 + 筛选 + 手动隔离/恢复按钮；API `PATCH /api/v1/cases/*` 增 `quarantined`；MCP `tern_list_cases` 返回携带；CLI `tern cases quarantine/unquarantine <caseId>`。

---

## F6. 定时任务

### 6.1 数据模型与调度

```sql
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  cron TEXT NOT NULL,                    -- 5 字段：分 时 日 月 周
  scope TEXT NOT NULL DEFAULT '{}',      -- CreateRunPayload 的选择器子集（tags/version/module/q/…）
  env TEXT,                              -- 环境名（引用 tern.yaml 定义；触发时现读展开，改 yaml 下轮生效）
  params TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}',
  max_attempts INTEGER NOT NULL DEFAULT 1,
  worker_id TEXT,
  title_prefix TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_id TEXT,
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
```

- 调度循环：`setInterval(15s)`（index.ts，与现有 300ms schedulerTick 并存不混淆）：取 `enabled=1 AND next_run_at<=now` 的 schedule，逐个：
  1. **防重叠**：`last_run_id` 指向的 run 仍非终态 → 跳过本次触发（`next_run_at` 照常推进，日志记录 skip）；
  2. `createRun({...scope, project, env, params, options, maxAttempts, workerId, title: "${title_prefix||name} ${MM-DD HH:mm}"}, createdBy='schedule:'+id)`；
  3. 更新 `last_run_at/last_run_id`，`next_run_at = next(cron, now)`。
- **错过补跑**：server 停机期间错过的触发，重启后若 `next_run_at < now - 10min` → 只补跑一次然后跳到未来最近触发点；10min 内的按原点触发（避免风暴）。
- cron 解析：内置 `cron.ts`（~100 行，零依赖），支持 `*`、`n`、`a-b`、`a-b/n`、`*/n`、逗号列表；日/周同时受限时按标准 cron 的 OR 语义；纯函数 `nextCron(expr, from: Date): Date`，单测覆盖月末/闰年/边界。校验失败的 schedule 创建返回 400 `INVALID_CRON`。

### 6.2 各端

API `GET/POST /api/v1/schedules`、`PATCH /schedules/:id`（含 enabled 开关）、`DELETE`；SDK 类型+client；MCP `tern_list_schedules`（Agent 可查巡检状态）；CLI `tern schedules list/create/pause/resume/rm`；Web 新页面「定时任务」（App.tsx 增导航）：列表（名称/cron/环境/下次触发/最近一次结果链接/开关）、创建表单（scope 复用发起运行的筛选组件）。

---

## F7. 钉钉机器人通知

### 7.1 配置

```sql
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),  -- NULL = 全局（对所有项目生效）
  type TEXT NOT NULL DEFAULT 'dingtalk',       -- 本期仅实现 dingtalk 发送器
  url TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',             -- 加签密钥（可空 = 不加签）
  notify_on TEXT NOT NULL DEFAULT 'failure',   -- 'always' | 'failure'
  enabled INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE batches ADD COLUMN notified_at TEXT;  -- 幂等标记
```

### 7.2 触发与发送

- 触发点：`recomputeRun` 判定 run 进入终态时（`writeBatchReport` 之后），fire-and-forget 调用 `notifyRunFinished(rt, batchId)`；成功后写 `notified_at`（幂等，重启重发无副作用——钉钉按 webhook 自然去重不做，靠 notified_at）。
- 匹配：该项目 webhooks + 全局 webhooks（project_id IS NULL），enabled=1，`notify_on='always'` 或（`=failure` 且存在 failed/timed_out/error）。
- 发送（`notifier.ts`，钉钉自定义机器人协议）：
  - 加签：`timestamp + '\n' + secret` HMAC-SHA256 → base64 → URL encode，拼 `&timestamp=&sign=`；
  - body：`{msgtype:'markdown', markdown:{title:'Tern 测试运行完成', text}}`；
  - markdown 内容：结果 emoji（✅/❌）、run 标题与 id、项目、**环境**、统计（通过/失败/flaky/跳过 + 总数）、耗时、失败分组 top3（label + count，复用 F4）、详情链接 `${PUBLIC_URL}/runs/<id>`；
  - `PUBLIC_URL` 新配置项（env，缺省 `http://<host>:<port>`），仅用于生成外链。
  - 超时 5s，失败重试 2 次（间隔 3s），最终失败仅 `log.warn` + `system.alert` 事件，绝不影响 run 主流程。
- Web：ProjectsPage 增「通知」区（webhook CRUD + notify_on + 启停 +「发送测试消息」按钮）；全局 webhook 用 API 直接配（Web 暂不做全局设置页）。

---

## 实施顺序（PR 切分）

1. **PR1 基础设施**：migration 7 全量 schema + `crypto.ts`（含单测）+ `error-sig.ts`（含单测）+ `cron.ts`（含单测）。
2. **PR2 F1 环境管理**：tern.yaml `env.variables` 清单解析（sync 镜像）+ 环境 CRUD（值加密存储、完备性校验）+ createRun 展开/分装 + assignRun 解密合并 + 脱敏；SDK/MCP/CLI/Web 同步。
3. **PR3 F2 Run 删除**：级联删除 + 产物清理 + 四端。
4. **PR4 F4 失败摘要**：handleResult 写 error_sig + failure-summary API + MCP 工具 + Web 分组视图。
5. **PR5 F3 trace viewer**：构建脚本提取 + 静态挂载 + 链接替换。
6. **PR6 F5 flaky**：case_stats 维护 + 隔离规则 + createRun 过滤 + 四端。
7. **PR7 F6+F7**：schedules 循环 + notifier（两者都在 run 生命周期挂点上收尾，适合合并验证）。

依赖关系：PR4/6 依赖 PR1；PR7 的通知文案引用环境与失败分组，建议在 PR2/PR4 之后。

## 测试计划

- 单测（`node --test`，沿用 dist 运行模式）：crypto 加解密 roundtrip 与错误密钥行为；tern.yaml `env.variables` 清单解析与校验（命名、secret 标志、防呆告警）；环境值完备性校验与参数展开分层（环境值/params 覆盖优先级、MISSING_ENV_VALUES 聚合报错、无清单 fail-closed）；error_sig 归一化用例表；cron parser（`* * * * *`、月末、`0 9 * * 1-5`、非法表达式）；case_stats 滚动窗口与隔离阈值边界（total=9/10、比率 0.29/0.3）；删除级联（migrations.test.ts 风格，内存 SQLite）。
- e2e（`scripts/e2e-test.mjs` 扩展）：demo 用例仓库 yaml 增变量清单 → 平台建环境并填值（含 secret）→ 跑 run → 断言 API 返回脱敏、worker 收到真值、缺值环境创建 run 即报 400 → 删除 run → 断言 DB 行与目录消失；失败摘要：跑含已知失败的 demo 用例 → 断言分组与 history；notifier：本地起 HTTP 假钉钉端点断言加签与 payload；schedule：注入时钟的单元级验证 + e2e 冒烟（enabled 开关与 next_run_at 推进，不真等 cron 触发）。

## 风险与兼容性

| 风险                                           | 应对                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| trace viewer 资源路径随 playwright 版本变化    | 构建脚本探测 + `TRACE_VIEWER_DIR` 显式覆盖 + 缺失时回退下载链接    |
| `params_secret` 密钥丢失                       | 发布说明明示；`data/.secret-key` 自动生成并 0600；只影响排队中 run |
| 清单变更（删变量残留无效值 / secret 标志翻转） | sync 报告提示 + UI 清理入口；翻转即时影响回显，存储不变            |
| 自动隔离误伤                                   | 阈值可配 + 默认 10 次窗口门槛 + system.alert 可见 + 手动优先于自动 |
| 删除大 run 长事务                              | 分块删除（500/批）；先删 events/case_runs 再删 batches             |
| cron 触发风暴（改系统时间/重复补跑）           | 补跑窗口 10min 单次；防重叠跳过；next_run_at 单调推进              |
| 钉钉限流（20 条/min）                          | 单 run 单消息（notified_at 幂等）；不做批量场景                    |
