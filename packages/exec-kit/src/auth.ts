import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuthRecipe, AuthStorageCookie, AuthValidateSpec } from '@tern/sdk';

/**
 * 登录态建立（docs/auth-design.md）：三种 mode（api / form / storage）都产出
 * Playwright storageState 文件。凭据占位符 ${ENV:VAR} 在 worker 端解析，
 * 凭据不进 server / 仓库。
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const ENV_RE = /\$\{ENV:([A-Za-z0-9_]+)\}/g;
const ACCOUNT_RE = /\$\{account\.([A-Za-z0-9_-]+)\}/;

export function replaceEnvPlaceholders<T>(value: T, env?: Record<string, string | undefined>): T {
  if (typeof value === 'string') {
    if (ACCOUNT_RE.test(value)) {
      throw new AuthError(
        `配置残留 \${account.…} 占位符（${value.trim()}）：账号字段应由 server 在派发时代入`,
      );
    }
    return value.replace(ENV_RE, (_m, name: string) => {
      const v = env?.[name] ?? process.env[name];
      if (v === undefined || v === '') {
        throw new AuthError(`环境变量 ${name} 未设置（auth 凭据占位符 \${ENV:${name}}）`);
      }
      return v;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => replaceEnvPlaceholders(v, env)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replaceEnvPlaceholders(v, env);
    }
    return out as unknown as T;
  }
  return value;
}

/** 相对路径拼接 baseUrl；完整 URL 原样返回 */
export function resolveAuthUrl(url: string, baseUrl?: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl)
    throw new AuthError(`auth 地址 "${url}" 是相对路径，但本次运行未提供 BASE_URL 参数`);
  return baseUrl.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

/** 无 BASE_URL 时从它推导 cookie domain / localStorage origin */
function deriveFromBaseUrl(baseUrl: string | undefined, what: string): string {
  if (!baseUrl) {
    throw new AuthError(
      `storage ${what} 未声明 domain/origin，且本次运行未提供 BASE_URL 参数，无法推导`,
    );
  }
  return new URL(baseUrl).origin;
}

interface StorageState {
  cookies: StorageStateCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}
interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

function toStateCookie(c: AuthStorageCookie, baseUrl: string | undefined): StorageStateCookie {
  if (!c.name) throw new AuthError(`storage cookie 缺少 name 字段`);
  const domain = c.domain ?? (baseUrl ? new URL(baseUrl).hostname : undefined);
  if (!domain)
    throw new AuthError(`storage cookie "${c.name}" 缺少 domain，且无法从 BASE_URL 推导`);
  return {
    name: c.name,
    value: c.value ?? '',
    domain,
    path: c.path ?? '/',
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite ?? 'Lax',
  };
}

/** 解析 Set-Cookie 头（name=value; Domain=..; Path=..; Expires=<http-date>）为 storageState cookie */
export function parseSetCookie(header: string, fallbackDomain: string): StorageStateCookie | null {
  const parts = header.split(';').map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const cookie: StorageStateCookie = {
    name: nameValue.slice(0, eq),
    value: nameValue.slice(eq + 1),
    domain: fallbackDomain,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
  for (const attr of attrs) {
    const [k, v] = attr.split('=');
    const key = (k ?? '').toLowerCase();
    if (key === 'domain') cookie.domain = v.replace(/^\./, '');
    else if (key === 'path') cookie.path = v || '/';
    else if (key === 'expires') {
      const t = Date.parse(v ?? '');
      if (Number.isFinite(t)) cookie.expires = Math.floor(t / 1000);
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') {
      const sv = (v ?? 'Lax').toLowerCase();
      cookie.sameSite = sv === 'strict' ? 'Strict' : sv === 'none' ? 'None' : 'Lax';
    }
  }
  return cookie;
}

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 从响应信封（{success, code, msg/message}）里取业务失败信息 */
function bizFailInfo(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const j = json as Record<string, unknown>;
  const parts: string[] = [];
  if (j['msg'] != null) parts.push(String(j['msg']));
  if (j['message'] != null && j['msg'] == null) parts.push(String(j['message']));
  if (j['code'] != null) parts.push(`code=${j['code']}`);
  return parts.join('（') + (parts.length > 1 ? '）' : '');
}

function normalizeValidate(v: AuthRecipe['validate']): AuthValidateSpec | null {
  if (!v) return null;
  if (typeof v === 'string') return v.trim() ? { url: v.trim() } : null;
  return v.url ? v : null;
}

/** 表单兼容旧字段名（userSelector/passSelector/submitSelector/successUrl） */
function formSelectors(recipe: AuthRecipe): {
  loginUrl: string;
  user: string;
  pass: string;
  submit: string;
} {
  const legacy = recipe as unknown as Record<string, unknown>;
  const loginUrl = recipe.loginUrl;
  const user = recipe.user ?? (legacy['userSelector'] as string | undefined);
  const pass = recipe.pass ?? (legacy['passSelector'] as string | undefined);
  const submit = recipe.submit ?? (legacy['submitSelector'] as string | undefined);
  for (const [name, val] of Object.entries({ loginUrl, user, pass, submit })) {
    if (!val) throw new AuthError(`auth mode=form 缺少必填字段 ${name}`);
  }
  return { loginUrl: loginUrl!, user: user!, pass: pass!, submit: submit! };
}

export interface ResolveAuthOptions {
  /** 运行参数 BASE_URL（相对地址拼接 / cookie domain 推导用） */
  baseUrl?: string;
  /** 解析 ${ENV:VAR} 使用的环境（默认 process.env；调用方应合并运行参数） */
  env?: Record<string, string | undefined>;
  /** storageState 输出文件路径 */
  statePath: string;
  headless?: boolean;
  /** form 模式登录失败时的截图 / trace 输出目录（挂到该 execution 的产物） */
  artifactsDir?: string;
  /** 登录过程日志（写入 run.log） */
  log?: (text: string) => void;
}

/**
 * 按登录配方生成 playwright storageState 文件，返回其路径。
 * - api：APIRequestContext 请求登录接口（支持 GET+query、重定向链），cookie jar 导出 storageState
 * - form：无头浏览器走登录页表单；失败时在 artifactsDir 留截图 + trace
 * - storage：按声明直写 cookie / localStorage（domain/origin 缺省从 BASE_URL 推导）
 */
export async function resolveAuthState(
  recipeRaw: AuthRecipe,
  opts: ResolveAuthOptions,
): Promise<string> {
  const log = opts.log ?? (() => {});
  if (recipeRaw.mode !== 'api' && recipeRaw.mode !== 'form' && recipeRaw.mode !== 'storage') {
    throw new AuthError(`未知 auth mode: ${(recipeRaw as { mode?: string }).mode}`);
  }
  // 替换 ${ENV:VAR}：短暂把 process.env 换成「worker env + 运行参数」合并视图
  const savedEnv = process.env;
  if (opts.env) {
    process.env = { ...savedEnv, ...opts.env } as NodeJS.ProcessEnv;
  }
  let recipe: AuthRecipe;
  try {
    recipe = replaceEnvPlaceholders(recipeRaw);
  } finally {
    if (opts.env) process.env = savedEnv;
  }

  const state: StorageState = { cookies: [], origins: [] };
  if (recipe.mode === 'form') {
    await formLogin(recipe, opts, state, log);
  } else if (recipe.mode === 'api') {
    await apiLogin(recipe, opts, state, log);
  } else {
    const storageCookies = [...(recipe.cookie ? [recipe.cookie] : []), ...(recipe.cookies ?? [])];
    state.cookies = storageCookies.map((c) => toStateCookie(c, opts.baseUrl));
    for (const item of recipe.localStorage ?? []) {
      const origin = (item.origin ?? deriveFromBaseUrl(opts.baseUrl, 'localStorage')).replace(
        /\/$/,
        '',
      );
      let bucket = state.origins.find((o) => o.origin === origin);
      if (!bucket) {
        bucket = { origin, localStorage: [] };
        state.origins.push(bucket);
      }
      bucket.localStorage.push({ name: item.key, value: item.value });
    }
    log(
      `auth: 注入直写 storage（${state.cookies.length} cookie / ${state.origins.length} origin）`,
    );
  }

  mkdirSync(path.dirname(opts.statePath), { recursive: true });
  writeFileSync(opts.statePath, JSON.stringify(state, null, 2));
  return opts.statePath;
}

// ---------- api 模式 ----------

async function apiLogin(
  recipe: AuthRecipe,
  opts: ResolveAuthOptions,
  state: StorageState,
  log: (text: string) => void,
): Promise<void> {
  if (!recipe.url) throw new AuthError('auth mode=api 缺少必填字段 url');
  const method = (recipe.method ?? 'POST').toUpperCase();
  const url = resolveAuthUrl(recipe.url, opts.baseUrl);
  log(
    `auth: 接口登录 ${method} ${url}${recipe.query ? ` query=${JSON.stringify(Object.keys(recipe.query))}` : ''}`,
  );
  const { request } = await import('playwright-core');
  const ctx = await request.newContext({ baseURL: opts.baseUrl });
  let res: Awaited<ReturnType<typeof ctx.fetch>>;
  try {
    res = await ctx.fetch(url, {
      method,
      // GET 不发送 body
      data: method === 'GET' ? undefined : recipe.body,
      headers: recipe.headers,
      params: recipe.query,
      maxRedirects: 20,
    });
  } catch (e) {
    throw new AuthError(`登录接口请求失败: ${(e as Error).message}`);
  }
  try {
    const status = res.status();
    if (status >= 400) {
      throw new AuthError(
        `登录接口返回 HTTP ${status}（${recipe.method ?? 'POST'} ${recipe.url}）`,
      );
    }
    // cookie jar 已含重定向链上全部 Set-Cookie；无 Domain 的 cookie 由 Playwright 按请求 host 记录
    const exported = (await ctx.storageState()) as StorageState;
    state.cookies = exported.cookies;
    state.origins = exported.origins;

    // body 只在需要时解析（成功判定 / save 规则 / 默认 success 字段检查）
    const success = recipe.success;
    const needJson = !!success?.json || !!recipe.save?.length;
    let json: unknown = undefined;
    const readJson = async (): Promise<unknown> => {
      if (json !== undefined) return json;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return json;
    };
    if (needJson) await readJson();

    if (success?.cookie) {
      const hit = state.cookies.some((c) => c.name === success.cookie);
      if (!hit) {
        throw new AuthError(
          `登录响应未种出 cookie "${success.cookie}"（${state.cookies.length ? `现有: ${state.cookies.map((c) => c.name).join(', ')}` : '无 cookie'}）${bizFailInfo(await readJson()) ? `：${bizFailInfo(json)}` : ''}`,
        );
      }
    }
    if (success?.json) {
      const val = getByPath(await readJson(), success.json);
      if (!val) {
        throw new AuthError(
          `登录响应 JSON 路径 "${success.json}" 非真值（登录被拒绝）${bizFailInfo(json) ? `：${bizFailInfo(json)}` : ''}`,
        );
      }
    }
    if (!success?.cookie && !success?.json) {
      // 默认判定：HTTP 2xx 且至少种出一个 cookie；body 含 success 字段时必须为真（业务失败可能仍 HTTP 200）
      if (status < 200 || status >= 300) {
        throw new AuthError(`登录接口返回 HTTP ${status}`);
      }
      if (state.cookies.length === 0) {
        throw new AuthError(`登录响应未种出任何 cookie，无法建立会话`);
      }
      const j = (await readJson()) as Record<string, unknown> | null;
      if (j && typeof j === 'object' && 'success' in j && !j['success']) {
        throw new AuthError(
          `登录被拒绝${bizFailInfo(j) ? `：${bizFailInfo(j)}` : '（success=false）'}`,
        );
      }
    }
    for (const rule of recipe.save ?? []) {
      const val = getByPath(json, rule.from);
      if (val === undefined || val === null) {
        throw new AuthError(`save 规则取值失败：响应中不存在路径 "${rule.from}"`);
      }
      const origin = (rule.origin ?? deriveFromBaseUrl(opts.baseUrl, 'localStorage')).replace(
        /\/$/,
        '',
      );
      let bucket = state.origins.find((o) => o.origin === origin);
      if (!bucket) {
        bucket = { origin, localStorage: [] };
        state.origins.push(bucket);
      }
      bucket.localStorage.push({ name: rule.key, value: String(val) });
    }
    log(
      `auth: 接口登录成功，获得 ${state.cookies.length} 个 cookie / ${state.origins.length} 个 origin`,
    );
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

// ---------- form 模式 ----------

async function formLogin(
  recipe: AuthRecipe,
  opts: ResolveAuthOptions,
  state: StorageState,
  log: (text: string) => void,
): Promise<void> {
  const { loginUrl: loginPath, user, pass, submit } = formSelectors(recipe);
  const loginUrl = resolveAuthUrl(loginPath, opts.baseUrl);
  log(`auth: 表单登录 ${loginUrl}`);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const ctx = await browser.newContext();
    if (opts.artifactsDir) {
      await ctx.tracing
        .start({ screenshots: true, snapshots: true, sources: false })
        .catch(() => {});
    }
    const page = await ctx.newPage();
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.fill(user, recipe.username ?? '');
      await page.fill(pass, recipe.password ?? '');
      await page.click(submit);
      const success = recipe.success;
      if (success?.url) {
        const pattern = resolveAuthUrl(success.url, opts.baseUrl);
        const glob = pattern.includes('*')
          ? pattern
          : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
          await page.waitForURL(glob, { timeout: 15_000 });
        } catch {
          throw new AuthError(
            `表单登录后未跳转到 ${success.url}（当前 ${page.url()}），请检查账号密码或选择器配置`,
          );
        }
      }
      if (success?.locator) {
        try {
          await page.waitForSelector(success.locator, { timeout: 15_000 });
        } catch {
          throw new AuthError(
            `表单登录后未出现元素 ${success.locator}（当前 ${page.url()}），请检查账号密码或选择器配置`,
          );
        }
      }
      if (!success?.url && !success?.locator) {
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      }
      const exported = (await ctx.storageState()) as StorageState;
      state.cookies = exported.cookies;
      state.origins = exported.origins;
      log(`auth: 表单登录成功，获得 ${state.cookies.length} 个 cookie`);
    } catch (e) {
      // 登录失败产物：截图 + trace 挂到该 execution
      if (opts.artifactsDir) {
        try {
          mkdirSync(opts.artifactsDir, { recursive: true });
          await page.screenshot({
            path: path.join(opts.artifactsDir, 'auth-failed.png'),
            fullPage: true,
          });
          await ctx.tracing.stop({ path: path.join(opts.artifactsDir, 'auth-failed.trace.zip') });
          log('auth: 已保存登录失败截图与 trace');
        } catch {
          /* 产物失败不影响错误上抛 */
        }
      }
      throw e;
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- 会话校验 ----------

export interface ValidateAuthOptions {
  baseUrl?: string;
  env?: Record<string, string | undefined>;
  log?: (text: string) => void;
}

/**
 * 校验缓存会话是否仍有效（docs/auth-design.md §7）：
 * 请求 validate URL（带当前 cookie）；HTTP 401/403、被跳到登录页、
 * 或 JSON body success===false → 视为失效（返回 false，调用方按原配方重登）。
 */
export async function validateAuthState(
  recipe: AuthRecipe,
  statePath: string,
  opts: ValidateAuthOptions = {},
): Promise<boolean> {
  const spec = normalizeValidate(recipe.validate);
  if (!spec) return true;
  const log = opts.log ?? (() => {});
  let url: string;
  const savedEnv = process.env;
  if (opts.env) {
    process.env = { ...savedEnv, ...opts.env } as NodeJS.ProcessEnv;
  }
  try {
    url = resolveAuthUrl(replaceEnvPlaceholders(spec.url), opts.baseUrl);
  } finally {
    if (opts.env) process.env = savedEnv;
  }
  const { request } = await import('playwright-core');
  const ctx = await request.newContext({ baseURL: opts.baseUrl, storageState: statePath });
  try {
    const res = await ctx.fetch(url, { method: 'GET', maxRedirects: 10 });
    const status = res.status();
    if (status === 401 || status === 403) {
      log(`auth: 会话校验失败（${url} → HTTP ${status}）`);
      return false;
    }
    // 仅在真实发生了重定向、且落在登录页路径段时判定为会话失效
    // （不能用 /login/i 子串匹配：findUserLoginInfo 这类路径也含 "Login"）
    const from = new URL(url);
    const to = new URL(res.url());
    if (
      to.pathname !== from.pathname &&
      /(^|\/)(login|signin|sign-in|logon)(\/|$)/i.test(to.pathname)
    ) {
      log(`auth: 会话校验失败（被重定向到登录页 ${res.url()}）`);
      return false;
    }
    if (spec.cookie) {
      const state = (await ctx.storageState()) as StorageState;
      if (!state.cookies.some((c) => c.name === spec.cookie)) {
        log(`auth: 会话校验失败（cookie ${spec.cookie} 已不存在）`);
        return false;
      }
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (
      json &&
      typeof json === 'object' &&
      (json as Record<string, unknown>)['success'] === false
    ) {
      log(
        `auth: 会话校验失败（${url} → success=false${bizFailInfo(json) ? `：${bizFailInfo(json)}` : ''}）`,
      );
      return false;
    }
    log(`auth: 会话校验通过（${url}）`);
    return true;
  } catch (e) {
    // 网络层失败无法证明会话失效，交给用例本身暴露问题
    log(`auth: 会话校验请求异常（${(e as Error).message}），按有效处理`);
    return true;
  } finally {
    await ctx.dispose().catch(() => {});
  }
}
