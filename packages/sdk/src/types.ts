// 共享类型：REST API / WS / 内部流转使用
export type CaseStatus = 'active' | 'deleted' | 'invalid' | 'disabled';
export type BatchStatus = 'pending' | 'running' | 'completed' | 'cancelled';
export type ItemStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'error'
  | 'skipped'
  | 'cancelled';
export type RunStatus =
  'running' | 'passed' | 'failed' | 'timed_out' | 'error' | 'skipped' | 'cancelled' | 'lost';
export type WorkerStatus = 'online' | 'busy' | 'offline';

// ---- 登录（auth 配方，拍平结构）----
// 设计见 docs/auth-design.md：登录配方（怎么登）/ 账号（用谁）/ 会话（storageState）三层。
// 配方只描述「怎么登」，凭据一律 ${ENV:VAR} 占位符，worker 端从运行参数/环境解析（不进 git、不落库）。

export interface AuthSuccessSpec {
  /** api：响应 Set-Cookie 必须含该 cookie 名（如 session_token） */
  cookie?: string;
  /** api：响应 JSON 该路径必须为真值（如 success / data.valid） */
  json?: string;
  /** form：登录成功后的地址（glob 通配，如匹配 /home） */
  url?: string;
  /** form：登录成功后页面应出现的选择器 */
  locator?: string;
}

/** 会话校验：请求该 URL（带当前 cookie），判定会话是否仍有效 */
export interface AuthValidateSpec {
  /** 校验地址（完整 URL 或相对路径，相对时拼接 BASE_URL） */
  url: string;
  /** 要求该 cookie 名仍存在 */
  cookie?: string;
}

export interface AuthApiSaveRule {
  /** 写入 localStorage 的 origin；省略时从 BASE_URL 推导 */
  origin?: string;
  key: string;
  /** 响应 JSON 的取值路径，如 "data.token" */
  from: string;
}

export interface AuthStorageCookie {
  name: string;
  value: string;
  /** 省略时从 BASE_URL 的 hostname 推导 */
  domain?: string;
  path?: string;
  /** unix 秒；省略为会话 cookie */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface AuthStorageItem {
  /** origin；省略时从 BASE_URL 推导 */
  origin?: string;
  key: string;
  value: string;
}

/** 账号表：名 → 字段键值（值可含 ${ENV:VAR} / 引用方可用 ${account.字段}） */
export type AuthAccounts = Record<string, Record<string, string>>;

/**
 * 登录配方（拍平；有顶层 mode 即单配方）。
 * - api：请求登录接口，收集 Set-Cookie（含重定向链）写入 storageState
 * - form：无头浏览器走登录页表单
 * - storage：直写 cookie / localStorage
 */
export interface AuthRecipe {
  mode: 'api' | 'form' | 'storage';
  /** 会话复用：worker（默认，worker 本 run 内按凭据缓存）| run | never */
  reuse?: 'worker' | 'run' | 'never';
  /** 会话校验：URL 路径或 { url, cookie }；缓存命中时先校验，失效重登 */
  validate?: string | AuthValidateSpec;
  /** 账号表（单配方；缺省名 default） */
  accounts?: AuthAccounts;

  // ---- api ----
  /** 登录地址；相对路径拼 BASE_URL */
  url?: string;
  /** 默认 POST；GET 时忽略 body */
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  /** api / form 的成功判定；api 省略时 = HTTP 2xx 且至少一个 cookie，body.success 为假值则失败 */
  success?: AuthSuccessSpec;
  /** api：响应字段写入 localStorage（token 类会话） */
  save?: AuthApiSaveRule[];

  // ---- form ----
  loginUrl?: string;
  /** 用户名 / 密码 / 提交按钮选择器 */
  user?: string;
  pass?: string;
  submit?: string;
  username?: string;
  password?: string;

  // ---- storage ----
  /** 单个 cookie 直写 */
  cookie?: AuthStorageCookie;
  /** 多个 cookie 直写 */
  cookies?: AuthStorageCookie[];
  localStorage?: AuthStorageItem[];
}

/** 项目仓库 auth 配置：单配方（有 mode）或多配方（名 → 配方） */
export interface AuthSnapshot {
  kind: 'single' | 'multi';
  /** single 时的配方 */
  recipe: AuthRecipe | null;
  /** multi 时的配方表 */
  profiles: Record<string, AuthRecipe>;
}

/** 派发时下发给 worker 的登录说明：快照中解析出的配方 + 账号字段已代入（${account.x} 已替换），
 *  ${ENV:VAR} 占位符仍原样保留，由 worker 用运行参数展开（凭据不落 server） */
export interface AuthSpec {
  /** 选中的账号名（default / admin / …）；配方无账号概念时为 null */
  account: string | null;
  recipe: AuthRecipe;
}

// ---- 项目（用例仓库）----

export type ProjectSource = 'git' | 'local';

export interface ProjectInfo {
  id: number;
  name: string;
  description: string;
  source: ProjectSource;
  gitUrl: string | null;
  branch: string | null;
  enabled: boolean;
  pullIntervalSec: number;
  /** git 拉取凭据摘要（secret 不回显） */
  credential: GitCredentialSummary;
  lastCommit: string | null;
  lastSyncedAt: string | null;
  /** ok | error | syncing | null（从未同步） */
  syncStatus: string | null;
  syncError: string | null;
  caseCount: number;
  updatedAt: string;
}

export type GitCredentialType = 'none' | 'password' | 'ssh';

export interface GitCredentialInput {
  type: GitCredentialType;
  /** password 认证的用户名 */
  username?: string;
  /** password 认证的密码，或 ssh 认证的私钥 PEM（写入库，接口不回显） */
  secret?: string;
}

export interface CreateProjectPayload {
  gitUrl: string;
  branch?: string;
  /** 缺省从仓库 tern.yaml 的 name 读取 */
  name?: string;
  pullIntervalSec?: number;
  /** git 拉取认证（默认 HTTP 账号密码；可选 SSH 私钥。容器内不用宿主机密钥） */
  credential?: GitCredentialInput;
}

export interface UpdateProjectPayload {
  enabled?: boolean;
  pullIntervalSec?: number;
  branch?: string;
  /** 更新 git 凭据；secret 省略则保留原值，type=none 清空 */
  credential?: GitCredentialInput;
  /**
   * 改名（小写 kebab-case，全局唯一）。项目名是用例库中 caseId 的第一段：
   * 改名后平台会自动重新同步，用例以新前缀（新项目名/…）重新入索引，旧 caseId 的记录成为历史。
   * git 项目的注册名与仓库 tern.yaml 的 name 不一致时以注册名为准——要让两边一致，
   * 改完仓库 tern.yaml 后用本字段把注册名也改掉。
   */
  name?: string;
}

/** 项目信息中的凭据摘要（secret 永不回显） */
export interface GitCredentialSummary {
  type: GitCredentialType;
  username: string | null;
  /** 是否已配置 secret */
  hasSecret: boolean;
}

export interface ProjectSyncResult {
  projectId: number;
  name: string;
  added: number;
  updated: number;
  removed: number;
  invalid: number;
  commit: string | null;
  error: string | null;
  invalidCases: { caseId: string; error: string }[];
  /** 环境变量清单（tern.yaml env.variables）同步告警（命名/防呆/残留值） */
  envWarnings?: string[];
  /** 测试资产（assetsDir）增删计数 */
  assetsAdded?: number;
  assetsRemoved?: number;
}

/** 项目测试资产（cases/_assets/，内容寻址存储） */
export interface ProjectAssetInfo {
  path: string;
  hash: string;
  bytes: number;
  status: 'active' | 'deleted';
  updatedAt: string;
}

export interface SyncResult {
  projects: ProjectSyncResult[];
  added: number;
  updated: number;
  removed: number;
  invalid: number;
  error: string | null;
}

export interface SyncInfo {
  id: number;
  projectId: number | null;
  startedAt: string;
  finishedAt: string | null;
  added: number;
  updated: number;
  removed: number;
  invalid: number;
  gitCommit: string | null;
  error: string | null;
}

// ---- 用例 ----

export interface CaseSummary {
  caseId: string;
  title: string;
  project: string;
  description: string;
  filePath: string;
  tags: string[];
  version: string | null;
  module: string | null;
  timeoutS: number;
  retries: number;
  /** 用例级 trace 覆盖（frontmatter trace；null=跟随运行级 options.trace） */
  traceMode: 'off' | 'on' | 'retain-on-failure' | null;
  disabled: boolean;
  status: CaseStatus;
  /** flaky 治理：已被隔离（默认不参与运行，仍可显式点名/包含） */
  quarantined: boolean;
  /** quarantined 的来源：auto | manual | auto-recovered */
  quarantinedBy: string | null;
  /** 滚动窗口 flaky 统计；无记录为 null */
  flakyStats: CaseFlakyStats | null;
  /** 声明的设备输入（fake 麦克风/摄像头，值为资产路径） */
  devices: { mic?: string; camera?: string } | null;
  /** 用例引用的全部测试资产路径（frontmatter devices + ternAsset() 调用） */
  assetRefs: string[];
  contentHash: string;
  bundleHash: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface RunBrief {
  id: string;
  status: RunStatus;
  flaky: boolean;
  attempt: number;
  workerId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: { name?: string; message?: string } | null;
}

export interface CaseDetail extends CaseSummary {
  source: string;
  meta: Record<string, unknown>;
  recentRuns: RunBrief[];
}

export interface TagInfo {
  tag: string;
  count: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetsInfo {
  projects: { name: string; count: number }[];
  versions: FacetValue[];
  modules: FacetValue[];
}

export interface RunOptions {
  trace: 'retain-on-failure' | 'on' | 'off';
  video: boolean;
  /** 设备输入覆盖（run 级）：值为资产路径（相对 assetsDir）；文件即 fake 设备输入源 */
  devices?: { mic?: string | null; camera?: string | null };
}

/**
 * 测试运行（Run）——一次测试执行（原「批次」）。
 * 一个 Run 只归属一个 project，可覆盖该 project 的多个版本、模块、tag。
 */
export interface RunInfo {
  id: string;
  title: string;
  createdBy: string;
  status: BatchStatus;
  /** 归属项目名 */
  project: string;
  /** 引用过的测试集名快照（未引用为 []） */
  suites: string[];
  /** 本次运行涉及的环境（多环境测试集并跑时 >1；无环境为 []） */
  envs: string[];
  /** 关联的环境名（创建时快照；未用环境为 null；多环境时为 null，看 envs） */
  envName: string | null;
  scope: Record<string, unknown>;
  /** 非敏感运行参数（敏感键不在其中，见 params_secret） */
  params: Record<string, string>;
  options: RunOptions;
  maxAttempts: number;
  workerId: string | null;
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  error: number;
  skipped: number;
  cancelled: number;
  gitCommit: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunItemInfo {
  id: string;
  runId: string;
  caseId: string;
  position: number;
  status: ItemStatus;
  attempt: number;
  maxAttempts: number;
  /** 该条目的执行环境（来自测试集绑定/run 环境的多环境上下文；NULL = 无环境） */
  env: string | null;
  /** 最终一次单用例执行（execution）的 ID */
  executionId: string | null;
  durationMs: number | null;
  lastError: string | null;
}

export interface RunDetail extends RunInfo {
  items: RunItemInfo[];
}

/** 单用例的一次执行（execution）——Run 内每个 item 的执行明细 */
export interface ExecutionDetail extends RunBrief {
  runId: string;
  caseId: string;
  bundleHash: string | null;
  artifacts: RunArtifacts | null;
  logTail: string[];
}

export interface RunArtifacts {
  trace?: string;
  screenshots?: string[];
  videos?: string[];
  attachments?: string[];
  log?: string;
  events?: string;
  missing?: string[];
}

export interface WorkerInfo {
  id: string;
  name: string;
  hostname: string;
  agentVersion: string;
  playwrightVersion: string;
  capabilities: { browsers: string[]; maxSlots: number };
  status: WorkerStatus;
  currentRunId: string | null;
  lastHeartbeatAt: string | null;
  registeredAt: string;
  stats: { executed?: number; passed?: number; failed?: number };
}

export interface MetaInfo {
  version: string;
  reposDir: string;
  gitCommit: string | null;
  lastSync: SyncInfo | null;
  stats: { activeCases: number; runningRuns: number; onlineWorkers: number; projects: number };
  status: 'ok' | 'starting';
}

export interface ListResp<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface RunQuery {
  status?: BatchStatus | 'all';
  project?: string;
  q?: string;
  createdBy?: string;
  workerId?: string;
  env?: string;
  /** 按引用过的测试集名筛选（匹配 scope 快照） */
  suite?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  offset?: number;
}

export interface CaseQuery {
  project?: string;
  version?: string[];
  module?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  excludeTags?: string[];
  q?: string;
  status?: CaseStatus | 'all';
  /** 隔离筛选：exclude=默认（与 createRun 排除规则一致）；only=只看隔离；all=不过滤 */
  quarantine?: 'exclude' | 'only' | 'all';
  limit?: number;
  offset?: number;
}

export interface CreateRunPayload {
  title?: string;
  createdBy?: string;
  /** 归属项目（必填；仅传 caseIds 时可从用例推导；传 suites 时可从测试集推导） */
  project?: string;
  /** 引用的测试集名（可多个，各用各的 env 绑定；与筛选/caseIds 并存，并集语义） */
  suites?: string[];
  version?: string[];
  module?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  excludeTags?: string[];
  caseIds?: string[];
  q?: string;
  /** 引用项目环境名（值在平台侧定义；展开后与 params 合并，params 显式覆盖优先） */
  env?: string;
  params?: Record<string, string>;
  /** params 中需按敏感处理的键（进加密存储，不回显） */
  secretParams?: string[];
  /** 内部：已加密的 secret 参数透传（params_secret 密文原样沿用，retry/调度复用） */
  secretParamsEnc?: string;
  options?: Partial<RunOptions>;
  maxAttempts?: number;
  /** 指定执行该运行的 worker（id 或名称）；缺省任意空闲 worker（可多 worker 并行） */
  workerId?: string;
  /** 纳入已隔离（quarantined）的用例；缺省排除（显式 caseIds 点名不受限） */
  includeQuarantined?: boolean;
}

// ---- WS 协议（Worker 通道）----
export interface WorkerHello {
  type: 'hello';
  name: string;
  version: string;
  playwrightVersion: string;
  capabilities: { browsers: string[]; maxSlots: number };
  lastRunId?: string;
}
export interface WorkerHelloAck {
  type: 'hello_ack';
  workerId: string;
  heartbeatIntervalMs: number;
}
export interface WorkerHelloReject {
  type: 'hello_reject';
  reason: string;
}
export interface WorkerHeartbeat {
  type: 'heartbeat';
  status: 'idle' | 'busy';
  currentRunId?: string;
}
export interface AssignTaskCase {
  caseId: string;
  title: string;
  bundleHash: string;
  bundleUrl: string;
  timeoutS: number;
  retries: number;
  attempt: number;
  maxAttempts: number;
  /** 用例声明的登录方式（无则为 null） */
  auth: AuthSpec | null;
  /** 用例声明的设备输入（fake 麦克风/摄像头；值为资产路径，经 options.devices 覆盖） */
  devices?: { mic?: string; camera?: string } | null;
}
export interface AssignTaskAsset {
  /** 相对 assetsDir 的逻辑路径（用例内 ternAsset() 的键） */
  path: string;
  /** sha256 hex（内容寻址） */
  hash: string;
  /** 下载地址（worker token 鉴权） */
  url: string;
  bytes: number;
}
export interface AssignTask {
  runId: string;
  runToken: string;
  /** 归属测试运行（Run）ID */
  testRunId: string;
  itemId: string;
  case: AssignTaskCase;
  params: Record<string, string>;
  options: RunOptions;
  /** 本次任务随行的测试资产（worker 下载缓存后经 TERN_ASSETS 注入用例） */
  assets?: AssignTaskAsset[];
  /** 设备反向代理模式（docs/device-proxy-design.md）：auto 按需 / on 强制 / off 禁用 */
  deviceProxy?: DeviceProxyMode;
}
export interface AssignMsg {
  type: 'assign';
  run: AssignTask;
}
export interface AcceptMsg {
  type: 'accept';
  runId: string;
  runToken: string;
}
export interface RejectMsg {
  type: 'reject';
  runId: string;
  runToken: string;
  reason?: string;
}
export type RunEventType = 'started' | 'log' | 'step' | 'frame';
export interface RunEvent {
  type: RunEventType;
  ts: string;
  level?: 'info' | 'warn' | 'error';
  text?: string;
  step?: { title: string; category?: string; phase: 'begin' | 'end' };
  data?: string; // frame: base64 jpeg
  screen?: string; // frame: 多屏时的屏标识（CDP targetId），单屏省略
  screenLabel?: string; // frame: 屏显示名（页面标题/URL）
}
export interface RunEventMsg {
  type: 'run_event';
  runId: string;
  runToken: string;
  event: RunEvent;
}
export interface ResultMsg {
  type: 'result';
  runId: string;
  runToken: string;
  status: RunStatus;
  flaky?: boolean;
  durationMs?: number;
  error?: { name?: string; message?: string; stack?: string } | null;
  artifacts?: RunArtifacts | null;
}
export interface CancelMsg {
  type: 'cancel';
  runId: string;
}
export interface ScreencastMsg {
  type: 'screencast_on' | 'screencast_off';
  runId: string;
}
export type WorkerMsg =
  WorkerHello | WorkerHeartbeat | AcceptMsg | RejectMsg | RunEventMsg | ResultMsg;
export type ServerMsg = WorkerHelloAck | WorkerHelloReject | AssignMsg | CancelMsg | ScreencastMsg;

// ---- WS 协议（App 通道）----
export interface SubscribeMsg {
  type: 'subscribe' | 'unsubscribe';
  topics: string[];
}
export interface AppEventEnvelope {
  type: 'event';
  topic: string;
  event: { type: string; ts: string; payload: unknown };
  id?: number;
}

// ---- 环境管理（docs/platform-enhancements.md F1）----
// 清单（契约）在用例仓库 tern.yaml 的 env.variables 节点声明；环境与值在平台侧定义。

/** 设备反向代理模式（环境级，docs/device-proxy-design.md）：auto=检测到不安全源按需启用 / on=强制 / off=禁用 */
export type DeviceProxyMode = 'auto' | 'on' | 'off';

/** tern.yaml env.variables 中的单个变量定义（sync 镜像，只读） */
export interface EnvVariable {
  key: string;
  description: string;
  /** true = 平台加密存储且 API 永不回显 */
  secret: boolean;
}

/** 平台侧环境（值整体加密存储；values 中 secret 键与未在清单声明的键回显为 null） */
export interface EnvironmentInfo {
  name: string;
  description: string;
  /** 环境值是否覆盖清单全部变量 */
  complete: boolean;
  /** 缺失的清单变量名 */
  missingKeys: string[];
  /** key → 值（secret/未知键为 null，表示「已配置但不回显」；未配置的键不出现） */
  values: Record<string, string | null>;
  /** 设备反向代理（环境级，docs/device-proxy-design.md）：auto 按需 / on 强制 / off 禁用 */
  deviceProxy: DeviceProxyMode;
  updatedAt: string;
}

export interface CreateEnvironmentPayload {
  /** 小写 kebab-case */
  name: string;
  description?: string;
  values: Record<string, string>;
  /** 设备反向代理模式，缺省 auto */
  deviceProxy?: DeviceProxyMode;
}

export interface UpdateEnvironmentPayload {
  name?: string;
  description?: string;
  /** 提供时整体替换值集（按清单校验未知键） */
  values?: Record<string, string>;
  /** 提供时更新设备反向代理模式 */
  deviceProxy?: DeviceProxyMode;
}

// ---- 失败摘要（F4）----

export interface FailureGroupItem {
  caseId: string;
  executionId: string | null;
  status: string;
  durationMs: number | null;
  error: { name?: string; message?: string } | null;
  screenshotUrl: string | null;
  traceUrl: string | null;
  /** 日志尾部（最近 20 行） */
  logTail: string[];
}

export interface FailureGroup {
  /** 错误签名（sha1 或 status: 兜底） */
  sig: string;
  /** 归一化消息首行（人读） */
  label: string;
  count: number;
  items: FailureGroupItem[];
  /** 同签名跨 run 历史 */
  history: { occurrenceRuns: number; firstSeenAt: string | null; lastSeenAt: string | null };
}

export interface FailureSummary {
  runId: string;
  groups: FailureGroup[];
}

// ---- flaky 治理（F5）----

export interface CaseFlakyStats {
  /** 滚动窗口内终态执行次数 */
  total: number;
  passed: number;
  failed: number;
  /** 判定为 flaky 的次数（runner 内重试通过 + run 级重试后通过） */
  flaky: number;
  /** flaky/total，窗口空为 null */
  rate: number | null;
  /** 滚动结果序列（旧→新）：p=passed f=failed F=flaky-pass s=skipped c=cancelled */
  history: string[];
}

export interface QuarantinePatch {
  quarantined: boolean;
}

/** 测试集选择器（docs/test-suite-design.md §3.1）：筛选条件 + 显式包含/排除，排除优先 */
export interface SuiteSelector {
  version?: string[];
  module?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  excludeTags?: string[];
  q?: string;
  /** 显式点名包含（与筛选命中取并集；被 excludeCaseIds 命中则仍排除） */
  includeCaseIds?: string[];
  /** 显式排除（最高优先级，压过筛选与显式包含） */
  excludeCaseIds?: string[];
  /** 纳入已隔离用例（默认排除；run 级 includeQuarantined 覆盖） */
  includeQuarantined?: boolean;
}

/** 测试集健康度（读取时现算）：命中数、悬空引用、环境/账号绑定状态 */
export interface SuiteHealth {
  /** 当前解析命中数 */
  resolvedCount: number;
  /** 因隔离被排除的数量 */
  quarantinedExcluded: number;
  /** includeCaseIds 中当前不存在/非 active 的 ID（git 演进正常现象，警示不报错） */
  danglingIncludes: string[];
  /** 同时出现在 include 与 exclude 的死条目 */
  deadEntries: string[];
  /** 绑定环境是否存在 + 值是否配齐清单（env 为 null 时为 null） */
  envStatus: 'ok' | 'incomplete' | 'missing' | null;
  /** 绑定账号是否存在于当前 auth 快照（account 为 null 时为 null） */
  accountKnown: boolean | null;
  /** 空选择器 = 项目全量（UI 显著标注） */
  isFullProject: boolean;
}

export interface SuiteInfo {
  /** ts_ 前缀 ULID */
  id: string;
  project: string;
  /** 项目内唯一，小写 kebab-case */
  name: string;
  description: string;
  selector: SuiteSelector;
  /** 绑定环境名（引用项目环境；run 引用该集时缺省用它，run 显式 env 覆盖拉平） */
  env: string | null;
  /** 绑定账号名（映射为运行参数 AUTH_ACCOUNT，只覆盖未声明 frontmatter auth 的用例） */
  account: string | null;
  /** 绑定运行参数（非敏感；敏感值走环境/secretParams） */
  params: Record<string, string>;
  enabled: boolean;
  health: SuiteHealth;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSuitePayload {
  name: string;
  description?: string;
  selector?: SuiteSelector;
  env?: string | null;
  account?: string | null;
  params?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateSuitePayload {
  name?: string;
  description?: string;
  selector?: SuiteSelector;
  env?: string | null;
  account?: string | null;
  params?: Record<string, string>;
  enabled?: boolean;
}

/** 单测试集解析预览（POST /projects/:id/suites/preview） */
export interface SuitePreview {
  health: SuiteHealth;
  /** 命中用例（limit 截断） */
  items: { caseId: string; title: string; quarantined: boolean }[];
}

/** run 创建 dry-run 预览（POST /runs/preview）：按环境上下文分组的命中构成 */
export interface RunPreview {
  /** 去重后（用例 × 环境）条目总数 */
  total: number;
  contexts: {
    env: string | null;
    sources: string[];
    caseCount: number;
    account: string | null | undefined;
  }[];
  perSuite: { name: string; resolvedCount: number }[];
  /** 同（用例 × 环境）被多个来源命中而去重的记录 */
  deduped: { caseId: string; env: string | null; keptFrom: string; droppedFrom: string[] }[];
  quarantinedExcluded: number;
}

// ---- 定时任务（F6）----

export interface ScheduleInfo {
  id: string;
  project: string;
  name: string;
  cron: string;
  scope: Record<string, unknown>;
  env: string | null;
  params: Record<string, string>;
  options: Partial<RunOptions>;
  maxAttempts: number;
  workerId: string | null;
  titlePrefix: string;
  enabled: boolean;
  lastRunId: string | null;
  lastRunAt: string | null;
  nextRunAt: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateSchedulePayload {
  project: string;
  name: string;
  /** 5 字段：分 时 日 月 周 */
  cron: string;
  /** CreateRunPayload 的选择器子集（tags/version/module/q/…） */
  scope?: Record<string, unknown>;
  env?: string;
  params?: Record<string, string>;
  options?: Partial<RunOptions>;
  maxAttempts?: number;
  workerId?: string;
  titlePrefix?: string;
  enabled?: boolean;
}

export interface UpdateSchedulePayload {
  name?: string;
  cron?: string;
  scope?: Record<string, unknown>;
  env?: string | null;
  params?: Record<string, string>;
  options?: Partial<RunOptions>;
  maxAttempts?: number;
  workerId?: string | null;
  titlePrefix?: string;
  enabled?: boolean;
}

// ---- Webhook 通知（支持 Generic HTTP Webhook 与 DingTalk）----
export type WebhookType = 'generic' | 'dingtalk' | string;

export interface WebhookInfo {
  id: number;
  /** null = 全局（对所有项目生效） */
  project: string | null;
  type: WebhookType;
  /** secret 已配置不回显原文 */
  hasSecret: boolean;
  /** always=每次完成都通知；failure=仅存在失败时 */
  notifyOn: 'always' | 'failure';
  enabled: boolean;
  createdAt: string;
}

export interface CreateWebhookPayload {
  /** 缺省 = 全局 */
  project?: string;
  type?: WebhookType;
  url: string;
  /** 加签密钥（可空 = 不加签；不回显） */
  secret?: string;
  notifyOn?: 'always' | 'failure';
}

export interface UpdateWebhookPayload {
  type?: WebhookType;
  url?: string;
  /** 省略保留原值；空串清除 */
  secret?: string;
  notifyOn?: 'always' | 'failure';
  enabled?: boolean;
}
