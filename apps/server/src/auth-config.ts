import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { ApiError } from './errors.js';
import type { AuthAccounts, AuthRecipe, AuthSnapshot, AuthSpec } from '@tern/sdk';

/**
 * 项目 auth 配置（docs/auth-design.md）：
 * - 位置：仓库根 tern.yaml / tern.yml 的 `auth:`；同目录 auth.yaml / auth.yml 存在时整段覆盖
 * - 形态：顶层有 mode = 单配方；否则顶层键为多配方名
 * - 时机：创建测试运行时从当前 clone 现读并快照进 run（执行以快照为准，projects.auth 仅展示/兜底）
 * - 兼容：旧嵌套形态（form: / api: / storage: 子对象、userSelector 等旧字段）读取时归一成拍平结构
 */

export const AUTH_OVERRIDE_FILES = ['auth.yaml', 'auth.yml'] as const;

function badConfig(msg: string): ApiError {
  return new ApiError(400, 'BAD_AUTH_CONFIG', msg);
}

function profileNotFound(msg: string): ApiError {
  return new ApiError(400, 'AUTH_PROFILE_NOT_FOUND', msg);
}

const ACCOUNT_RE = /\$\{account\.([A-Za-z0-9_-]+)\}/g;

// ---------- 归一化（兼容旧嵌套形态）----------

function flattenLegacy(recipe: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...recipe };
  // 旧形态：mode: form + form: { loginUrl, userSelector, ... }
  const form = out['form'];
  if (form && typeof form === 'object') {
    const f = form as Record<string, unknown>;
    for (const k of ['loginUrl', 'username', 'password']) {
      if (out[k] === undefined && f[k] !== undefined) out[k] = f[k];
    }
    if (out['user'] === undefined && f['userSelector'] !== undefined)
      out['user'] = f['userSelector'];
    if (out['pass'] === undefined && f['passSelector'] !== undefined)
      out['pass'] = f['passSelector'];
    if (out['submit'] === undefined && f['submitSelector'] !== undefined)
      out['submit'] = f['submitSelector'];
    if (f['successUrl'] !== undefined)
      out['success'] = { ...((out['success'] as object) ?? {}), url: f['successUrl'] };
    delete out['form'];
  }
  // 旧形态：mode: api + api: { url, method, body, save }
  const api = out['api'];
  if (api && typeof api === 'object') {
    const a = api as Record<string, unknown>;
    for (const k of ['url', 'method', 'query', 'headers', 'body', 'save']) {
      if (out[k] === undefined && a[k] !== undefined) out[k] = a[k];
    }
    delete out['api'];
  }
  // 旧形态：mode: storage + storage: { cookies, localStorage }
  const storage = out['storage'];
  if (storage && typeof storage === 'object') {
    const s = storage as Record<string, unknown>;
    for (const k of ['cookie', 'cookies', 'localStorage']) {
      if (out[k] === undefined && s[k] !== undefined) out[k] = s[k];
    }
    delete out['storage'];
  }
  return out;
}

function strMap(v: unknown, what: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw badConfig(`auth ${what} 必须是键值映射`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined || val === null) throw badConfig(`auth ${what}.${k} 不能为空`);
    out[k] = String(val);
  }
  return out;
}

/** 归一 + 校验单个配方；非法抛 ApiError(BAD_AUTH_CONFIG) */
export function normalizeAuthRecipe(raw: unknown, where = 'auth'): AuthRecipe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badConfig(`${where} 配方必须是 YAML 映射`);
  }
  const flat = flattenLegacy(raw as Record<string, unknown>);
  const mode = flat['mode'];
  if (mode !== 'api' && mode !== 'form' && mode !== 'storage') {
    throw badConfig(`${where} 缺少合法的 mode（api | form | storage）`);
  }
  const recipe: AuthRecipe = { mode };
  const pickStr = (k: string): string | undefined =>
    flat[k] === undefined ? undefined : String(flat[k]);

  if (flat['reuse'] !== undefined) {
    if (flat['reuse'] !== 'worker' && flat['reuse'] !== 'run' && flat['reuse'] !== 'never') {
      throw badConfig(`${where} reuse 只支持 worker | run | never`);
    }
    recipe.reuse = flat['reuse'];
  }
  if (flat['validate'] !== undefined) {
    const v = flat['validate'];
    if (typeof v === 'string' && v.trim()) recipe.validate = v.trim();
    else if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      (v as Record<string, unknown>)['url']
    ) {
      const spec = v as Record<string, unknown>;
      recipe.validate = {
        url: String(spec['url']),
        ...(spec['cookie'] !== undefined ? { cookie: String(spec['cookie']) } : {}),
      };
    } else {
      throw badConfig(`${where} validate 需为 URL 路径或 { url, cookie }`);
    }
  }
  if (flat['accounts'] !== undefined) {
    const accounts = flat['accounts'] as AuthAccounts;
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
      throw badConfig(`${where} accounts 必须是 名 → 字段键值 的映射`);
    }
    for (const [name, fields] of Object.entries(accounts)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw badConfig(`${where} accounts.${name} 必须是键值映射`);
      }
    }
    recipe.accounts = accounts;
  }

  if (mode === 'api') {
    const url = pickStr('url');
    if (!url) throw badConfig(`${where} mode=api 缺少必填字段 url`);
    recipe.url = url;
    if (flat['method'] !== undefined) recipe.method = String(flat['method']);
    const query = strMap(flat['query'], 'query');
    if (query) recipe.query = query;
    const headers = strMap(flat['headers'], 'headers');
    if (headers) recipe.headers = headers;
    if (flat['body'] !== undefined) recipe.body = flat['body'];
    if (flat['save'] !== undefined) {
      if (!Array.isArray(flat['save'])) throw badConfig(`${where} save 必须是数组`);
      recipe.save = (flat['save'] as Record<string, unknown>[]).map((r, i) => {
        if (!r || typeof r !== 'object' || !r['key'] || !r['from']) {
          throw badConfig(`${where} save[${i}] 需要 key 与 from 字段`);
        }
        return {
          ...(r['origin'] !== undefined ? { origin: String(r['origin']) } : {}),
          key: String(r['key']),
          from: String(r['from']),
        };
      });
    }
  }
  if (mode === 'form') {
    for (const k of ['loginUrl', 'user', 'pass', 'submit'] as const) {
      const v = pickStr(k);
      if (!v) throw badConfig(`${where} mode=form 缺少必填字段 ${k}`);
      recipe[k] = v;
    }
    if (flat['username'] !== undefined) recipe.username = String(flat['username']);
    if (flat['password'] !== undefined) recipe.password = String(flat['password']);
  }
  if (mode === 'storage') {
    const cookies = [
      ...(flat['cookie'] ? [flat['cookie']] : []),
      ...(Array.isArray(flat['cookies']) ? flat['cookies'] : []),
    ];
    const ls = flat['localStorage'];
    if (!cookies.length && !Array.isArray(ls)) {
      throw badConfig(`${where} mode=storage 需要声明 cookie / cookies / localStorage`);
    }
    if (flat['cookie']) recipe.cookie = flat['cookie'] as AuthRecipe['cookie'];
    if (Array.isArray(flat['cookies'])) recipe.cookies = flat['cookies'] as AuthRecipe['cookies'];
    if (Array.isArray(ls)) recipe.localStorage = ls as AuthRecipe['localStorage'];
  }
  if (flat['success'] !== undefined) {
    const s = flat['success'];
    if (s !== null && typeof s === 'object' && !Array.isArray(s)) {
      const src = s as Record<string, unknown>;
      const success: AuthRecipe['success'] = {};
      for (const k of ['cookie', 'json', 'url', 'locator'] as const) {
        if (src[k] !== undefined) success[k] = String(src[k]);
      }
      if (Object.keys(success).length) recipe.success = success;
    } else if (typeof s === 'string' && s.trim()) {
      // 简写：success: '**/home'（form url）或 'COOKIE' 难以区分，仅接受映射
      throw badConfig(`${where} success 需为映射（api: {cookie,json} / form: {url,locator}）`);
    }
  }
  return recipe;
}

/** 归一整份 auth 配置：顶层有 mode = 单配方；否则为多配方（名 → 配方） */
export function normalizeAuthConfig(raw: unknown, where = 'auth'): AuthSnapshot {
  if (raw === undefined || raw === null) return { kind: 'multi', recipe: null, profiles: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badConfig(`${where} 必须是映射（单配方含 mode，或多配方 名 → 配方）`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj['mode'] !== undefined) {
    return { kind: 'single', recipe: normalizeAuthRecipe(obj, where), profiles: {} };
  }
  const profiles: Record<string, AuthRecipe> = {};
  for (const [name, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw badConfig(`${where}.${name} 配方必须是映射`);
    }
    profiles[name] = normalizeAuthRecipe(value, `${where}.${name}`);
  }
  return { kind: 'multi', recipe: null, profiles };
}

// ---------- 仓库读取 ----------

interface TernDoc {
  auth?: unknown;
}

function readYaml(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return (yamlParse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw badConfig(`${path.basename(file)} 解析失败: ${(e as Error).message}`);
  }
}

/**
 * 读取仓库根的原始 auth 配置：tern.yaml / tern.yml 的 `auth:` 为默认；
 * 同目录 auth.yaml / auth.yml 存在时整段覆盖（方便配方较长时把 meta 拆开）。
 */
export function readAuthRaw(
  repoDir: string,
  metaFiles: readonly string[] = ['tern.yaml', 'tern.yml'],
): unknown {
  let raw: unknown;
  for (const f of metaFiles) {
    const doc = readYaml(path.join(repoDir, f)) as TernDoc | null;
    if (!doc) continue;
    raw = doc['auth'];
    break;
  }
  for (const f of AUTH_OVERRIDE_FILES) {
    const doc = readYaml(path.join(repoDir, f));
    if (!doc) continue;
    // 允许习惯性写一层 auth: 键；其余情况整份文件即 auth 配置
    const keys = Object.keys(doc);
    raw =
      keys.length === 1 && keys[0] === 'auth' && doc['auth'] && typeof doc['auth'] === 'object'
        ? doc['auth']
        : doc;
    break;
  }
  return raw;
}

/** 从项目仓库根读取 auth 配置并归一化（创建 run 快照 / 派发解析用） */
export function readAuthSnapshot(repoDir: string, metaFiles?: readonly string[]): AuthSnapshot {
  return normalizeAuthConfig(readAuthRaw(repoDir, metaFiles), 'auth');
}

// ---------- 引用解析 ----------

/** 用例 frontmatter 的 auth 名是否可解析（sync 时校验用） */
export function checkAuthRef(
  snapshot: AuthSnapshot,
  ref: string | null | undefined,
  where: string,
): void {
  if (!ref || ref === 'none') return;
  if (snapshot.kind === 'multi') {
    if (!snapshot.profiles[ref]) {
      throw profileNotFound(
        `${where}：声明 auth: ${ref}，但项目 auth 配置中不存在该配方（可选: ${Object.keys(snapshot.profiles).join('、') || '（无）'}）`,
      );
    }
    return;
  }
  // 单配方：ref 为账号名（default 隐含存在）
  if (ref === 'default') return;
  const accounts = snapshot.recipe?.accounts;
  if (!accounts || !accounts[ref]) {
    throw profileNotFound(
      `${where}：声明 auth: ${ref}，但登录配方未声明该账号（accounts 可选: ${accounts ? Object.keys(accounts).join('、') : '（无账号表，仅 default）'}）`,
    );
  }
}

/** 把 ${account.field} 替换为账号原始值（值里的 ${ENV:} 保留给 worker 解析） */
function substituteAccount(
  recipe: AuthRecipe,
  fields: Record<string, string>,
  accountName: string,
): AuthRecipe {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(ACCOUNT_RE, (_m, field: string) => {
        if (!(field in fields)) {
          throw badConfig(`账号 ${accountName} 缺少字段 ${field}（被 ${v.trim()} 引用）`);
        }
        return fields[field];
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const replaced = walk(recipe) as AuthRecipe;
  // 账号表已代入，不再下发给 worker
  delete (replaced as Partial<AuthRecipe>).accounts;
  return replaced;
}

/**
 * 派发解析：用例 auth 名 + 运行参数 AUTH_ACCOUNT → 下发给 worker 的 { account, recipe } | null。
 * - 不写 auth：单配方走默认账号（AUTH_ACCOUNT 可覆盖）；多配方走 default 配方（无则不登录）
 * - auth: none：不登录
 * - auth: <名>：单配方 = 账号名；多配方 = 配方名（不被 AUTH_ACCOUNT 覆盖）
 */
export function resolveAuthSpec(
  snapshot: AuthSnapshot,
  ref: string | null | undefined,
  authAccountParam?: string,
): AuthSpec | null {
  if (ref === 'none') return null;
  if (snapshot.kind === 'multi') {
    const name = ref || authAccountParam || (snapshot.profiles['default'] ? 'default' : null);
    if (!name) return null;
    const profile = snapshot.profiles[name];
    if (!profile) {
      throw profileNotFound(
        `auth: ${name} 不存在于项目 auth 配置（可选: ${Object.keys(snapshot.profiles).join('、') || '（无）'}）`,
      );
    }
    const accounts = profile.accounts ?? {};
    const account = ref
      ? 'default'
      : authAccountParam && accounts[authAccountParam]
        ? authAccountParam
        : 'default';
    if (accounts && Object.keys(accounts).length && !accounts[account]) {
      throw profileNotFound(
        `auth: ${name} 未声明账号 ${account}（accounts 可选: ${Object.keys(accounts).join('、')}）`,
      );
    }
    return {
      account: Object.keys(accounts).length ? account : null,
      recipe: Object.keys(accounts).length
        ? substituteAccount(profile, accounts[account], account)
        : profile,
    };
  }
  const recipe = snapshot.recipe;
  if (!recipe) return null;
  const accounts = recipe.accounts ?? {};
  const hasAccounts = Object.keys(accounts).length > 0;
  // ref 指定了账号则用 ref；否则 AUTH_ACCOUNT 覆盖默认账号
  const account =
    ref && ref !== 'default' ? ref : authAccountParam && hasAccounts ? authAccountParam : 'default';
  if (!hasAccounts) {
    if (ref && ref !== 'default') {
      throw profileNotFound(`登录配方未声明账号表（accounts），无法使用账号 ${ref}（仅 default）`);
    }
    return { account: null, recipe };
  }
  if (!accounts[account]) {
    throw profileNotFound(
      `登录配方未声明账号 ${account}（accounts 可选: ${Object.keys(accounts).join('、')}）`,
    );
  }
  return { account, recipe: substituteAccount(recipe, accounts[account], account) };
}
