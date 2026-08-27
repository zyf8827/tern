import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeAuthConfig,
  normalizeAuthRecipe,
  readAuthRaw,
  readAuthSnapshot,
  checkAuthRef,
  resolveAuthSpec,
} from './auth-config.js';
import { ApiError } from './errors.js';

function tmpRepo(files: Record<string, string>): string {
  const dir = path.join(
    os.tmpdir(),
    `tern-auth-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function expectApiError(fn: () => unknown, code: string): ApiError {
  try {
    fn();
  } catch (e) {
    const err = e as ApiError;
    assert.equal(err.code, code, `应抛 ${code}，实际: ${err.message}`);
    return err;
  }
  throw new Error(`应抛出 ${code}`);
}

const API_RECIPE = {
  mode: 'api',
  method: 'GET',
  url: '/api/auth/mock-login',
  query: { clientId: '${account.clientId}' },
  success: { cookie: 'session_token', json: 'success' },
  validate: '/api/auth/findUserLoginInfo',
};

test('单配方：顶层有 mode → kind=single', () => {
  const snap = normalizeAuthConfig({ ...API_RECIPE });
  assert.equal(snap.kind, 'single');
  assert.equal(snap.recipe?.mode, 'api');
  assert.equal(snap.recipe?.method, 'GET');
});

test('多配方：无 mode → kind=multi，逐个归一化', () => {
  const snap = normalizeAuthConfig({
    sso: { mode: 'form', loginUrl: '/login', user: '#u', pass: '#p', submit: '#s' },
  });
  assert.equal(snap.kind, 'multi');
  assert.equal(snap.profiles['sso']?.mode, 'form');
  assert.equal(snap.profiles['sso']?.user, '#u');
});

test('空配置 → 无登录', () => {
  for (const raw of [undefined, null, {}]) {
    const snap = normalizeAuthConfig(raw);
    assert.equal(snap.kind, 'multi');
    assert.deepEqual(snap.profiles, {});
    assert.equal(resolveAuthSpec(snap, null), null);
    assert.equal(resolveAuthSpec(snap, 'none'), null);
  }
});

test('旧嵌套形态归一：form:/api:/storage: 拍平，旧选择器名映射', () => {
  const snap = normalizeAuthConfig({
    'form-login': {
      mode: 'form',
      form: {
        loginUrl: '/login',
        userSelector: '#username',
        passSelector: '#password',
        submitSelector: '#login-btn',
        successUrl: '/',
        username: '${ENV:U}',
        password: '${ENV:P}',
      },
    },
    'api-login': { mode: 'api', api: { url: '/api/login', method: 'POST', body: { u: 1 } } },
    'storage-login': {
      mode: 'storage',
      storage: { cookies: [{ name: 's', value: 'v', domain: 'h' }] },
    },
  });
  assert.equal(snap.kind, 'multi');
  const form = snap.profiles['form-login']!;
  assert.equal(form.loginUrl, '/login');
  assert.equal(form.user, '#username');
  assert.equal(form.pass, '#password');
  assert.equal(form.submit, '#login-btn');
  assert.equal(form.success?.url, '/');
  assert.equal((form as unknown as Record<string, unknown>)['form'], undefined);
  const api = snap.profiles['api-login']!;
  assert.equal(api.url, '/api/login');
  assert.equal(api.method, 'POST');
  assert.equal((api as unknown as Record<string, unknown>)['api'], undefined);
  const storage = snap.profiles['storage-login']!;
  assert.equal(storage.cookies?.[0]?.name, 's');
  assert.equal((storage as unknown as Record<string, unknown>)['storage'], undefined);
});

test('非法配方：缺 mode / 缺必填字段 → BAD_AUTH_CONFIG', () => {
  expectApiError(() => normalizeAuthConfig({ url: '/x' }), 'BAD_AUTH_CONFIG');
  expectApiError(() => normalizeAuthConfig({ mode: 'api' }), 'BAD_AUTH_CONFIG');
  expectApiError(
    () => normalizeAuthConfig({ mode: 'form', loginUrl: '/login' }),
    'BAD_AUTH_CONFIG',
  );
  expectApiError(() => normalizeAuthConfig({ mode: 'storage' }), 'BAD_AUTH_CONFIG');
  expectApiError(
    () => normalizeAuthRecipe({ mode: 'api', url: '/x', reuse: 'bogus' }),
    'BAD_AUTH_CONFIG',
  );
});

test('readAuthRaw/readAuthSnapshot：tern.yaml 默认，auth.yaml 整段覆盖', () => {
  const dir = tmpRepo({
    'tern.yaml': `name: demo\nauth:\n  mode: api\n  url: /old\n`,
    'auth.yaml': `mode: api\nurl: /new\nquery:\n  clientId: \${ENV:CLIENT_ID}\n`,
  });
  assert.equal((readAuthRaw(dir) as { url: string }).url, '/new');
  const snap = readAuthSnapshot(dir);
  assert.equal(snap.kind, 'single');
  assert.equal(snap.recipe?.url, '/new');

  // auth.yaml 习惯性写一层 auth: 键也能识别
  const dir2 = tmpRepo({
    'tern.yaml': `name: demo\n`,
    'auth.yaml': `auth:\n  mode: api\n  url: /wrapped\n`,
  });
  assert.equal((readAuthSnapshot(dir2).recipe as { url: string }).url, '/wrapped');

  // 无 auth.yaml 时读 tern.yaml
  const dir3 = tmpRepo({
    'tern.yaml': `name: demo\nauth:\n  mode: storage\n  cookie:\n    name: t\n    value: v\n`,
  });
  assert.equal(readAuthSnapshot(dir3).recipe?.mode, 'storage');
});

test('checkAuthRef：单配方校验账号名，多配方校验配方名，none 恒合法', () => {
  const single = normalizeAuthConfig({
    ...API_RECIPE,
    accounts: { default: { clientId: 'a' }, admin: { clientId: 'b' } },
  });
  checkAuthRef(single, null, 'x');
  checkAuthRef(single, 'none', 'x');
  checkAuthRef(single, 'default', 'x');
  checkAuthRef(single, 'admin', 'x');
  expectApiError(() => checkAuthRef(single, 'nope', '用例 c1'), 'AUTH_PROFILE_NOT_FOUND');

  const singleNoAccounts = normalizeAuthConfig({ ...API_RECIPE });
  checkAuthRef(singleNoAccounts, 'default', 'x');
  expectApiError(
    () => checkAuthRef(singleNoAccounts, 'admin', '用例 c2'),
    'AUTH_PROFILE_NOT_FOUND',
  );

  const multi = normalizeAuthConfig({
    sso: { mode: 'form', loginUrl: '/l', user: 'u', pass: 'p', submit: 's' },
  });
  checkAuthRef(multi, 'sso', 'x');
  expectApiError(() => checkAuthRef(multi, 'ghost', '用例 c3'), 'AUTH_PROFILE_NOT_FOUND');
});

test('resolveAuthSpec：单配方 + 账号代入 ${account.x}，AUTH_ACCOUNT 覆盖缺省账号', () => {
  const single = normalizeAuthConfig({
    ...API_RECIPE,
    accounts: {
      default: { clientId: '${ENV:CLIENT_ID}' },
      admin: { clientId: '${ENV:ADMIN_CLIENT_ID}' },
    },
  });
  // 缺省 → default 账号；${account.clientId} 代入为账号原始值（ENV 占位符保留给 worker）
  const dflt = resolveAuthSpec(single, null)!;
  assert.equal(dflt.account, 'default');
  assert.equal((dflt.recipe.query as { clientId: string }).clientId, '${ENV:CLIENT_ID}');
  assert.equal(dflt.recipe.accounts, undefined, '账号表不应下发 worker');
  // frontmatter 指定账号
  const admin = resolveAuthSpec(single, 'admin')!;
  assert.equal((admin.recipe.query as { clientId: string }).clientId, '${ENV:ADMIN_CLIENT_ID}');
  // AUTH_ACCOUNT 覆盖「未写 auth」的用例
  const overridden = resolveAuthSpec(single, null, 'admin')!;
  assert.equal(overridden.account, 'admin');
  // 写了 auth: auditor 的不被覆盖（这里没有 auditor → 保持 ref 指定失败）
  expectApiError(() => resolveAuthSpec(single, 'auditor', 'admin'), 'AUTH_PROFILE_NOT_FOUND');
});

test('resolveAuthSpec：多配方按名解析，无名字回退 default 配方，否则不登录', () => {
  const multi = normalizeAuthConfig({
    default: { ...API_RECIPE, query: { clientId: '${ENV:CLIENT_ID}' } },
    sso: { mode: 'form', loginUrl: '/l', user: 'u', pass: 'p', submit: 's' },
  });
  assert.equal(resolveAuthSpec(multi, 'sso')!.recipe.mode, 'form');
  assert.equal(resolveAuthSpec(multi, null)!.recipe.mode, 'api');
  assert.equal(resolveAuthSpec(multi, null, 'sso')!.recipe.mode, 'form', 'AUTH_ACCOUNT 选择配方');
  expectApiError(() => resolveAuthSpec(multi, 'ghost'), 'AUTH_PROFILE_NOT_FOUND');
  // 无 default 配方且未写 auth → 不登录
  const noDefault = normalizeAuthConfig({
    sso: { mode: 'form', loginUrl: '/l', user: 'u', pass: 'p', submit: 's' },
  });
  assert.equal(resolveAuthSpec(noDefault, null), null);
});

test('resolveAuthSpec：配方声明 accounts 时账号字段缺失 → BAD_AUTH_CONFIG', () => {
  const single = normalizeAuthConfig({
    mode: 'api',
    url: '/login',
    query: { clientId: '${account.clientId}', region: '${account.region}' },
    accounts: { default: { clientId: 'c' } },
  });
  expectApiError(() => resolveAuthSpec(single, null), 'BAD_AUTH_CONFIG');
});
