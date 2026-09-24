import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './frontmatter.js';

test('解析标准 @tern frontmatter', () => {
  const src = `/**
 * @tern
 * title: 登录测试
 * description: 验证登录
 * tags: [Smoke, Login, v1.2]
 * timeout: 90
 * retries: 1
 * author: agent
 * custom-field: hello
 */
import { test } from '@playwright/test';
`;
  const fm = parseFrontmatter(src)!;
  assert.ok(fm);
  assert.equal(fm.errors.length, 0);
  assert.equal(fm.meta.title, '登录测试');
  assert.deepEqual(fm.meta.tags, ['smoke', 'login', 'v1.2']);
  assert.equal(fm.meta.timeout, 90);
  assert.equal(fm.meta.retries, 1);
  assert.equal(fm.meta.author, 'agent');
  assert.deepEqual(fm.meta.meta, { 'custom-field': 'hello' });
});

test('忽略不含 @tern 标记的普通块注释', () => {
  const src = `/**
 * 版权说明（普通注释，不是 frontmatter）
 */
import { test } from '@playwright/test';
`;
  assert.equal(parseFrontmatter(src), null);
});

test('trace 字段：合法值解析、非法值报错', () => {
  const ok = parseFrontmatter(`/**
 * @tern
 * title: 长录音用例
 * tags: [device]
 * trace: off
 */
`)!;
  assert.equal(ok.meta.trace, 'off');
  assert.equal(ok.errors.length, 0);

  const bad = parseFrontmatter(`/**
 * @tern
 * title: 长录音用例
 * tags: [device]
 * trace: whatever
 */
`)!;
  assert.equal(bad.meta.trace, undefined);
  assert.ok(bad.errors.some((e) => e.includes('trace 只允许')));
});

test('缺失 title 报错', () => {
  const src = `/**
 * @tern
 * tags: [a]
 */
`;
  const fm = parseFrontmatter(src)!;
  assert.ok(fm.errors.some((e) => e.includes('title')));
});

test('找不到 @tern 块返回 null', () => {
  assert.equal(parseFrontmatter('const x = 1;'), null);
});

test('tags 支持逗号字符串', () => {
  const fm = parseFrontmatter(`/**\n * @tern\n * title: t\n * tags: a, b\n */`)!;
  assert.deepEqual(fm.meta.tags, ['a', 'b']);
});

test('非法 timeout 报错', () => {
  const fm = parseFrontmatter(`/**\n * @tern\n * title: t\n * timeout: abc\n */`)!;
  assert.ok(fm.errors.some((e) => e.includes('timeout')));
});

test('解析 version / module / auth 字段', () => {
  const src = `/**
 * @tern
 * title: 登录测试
 * tags: [smoke]
 * version: v2.3
 * module: login
 * auth: form-login
 */
import { test } from '@playwright/test';
`;
  const fm = parseFrontmatter(src)!;
  assert.equal(fm.errors.length, 0);
  assert.equal(fm.meta.version, 'v2.3');
  assert.equal(fm.meta.module, 'login');
  assert.equal(fm.meta.auth, 'form-login');
  // 已知字段不落入自由 meta
  assert.deepEqual(fm.meta.meta, {});
});

test('devices：对象形式（fake mic/camera 文件）', () => {
  const fm = parseFrontmatter(`/**
 * @tern
 * title: 录音
 * devices:
 *   mic: audio/interview-16k.wav
 *   camera: video/front.y4m
 */
`)!;
  assert.equal(fm.errors.length, 0);
  assert.deepEqual(fm.meta.devices, { mic: 'audio/interview-16k.wav', camera: 'video/front.y4m' });
  assert.deepEqual(fm.meta.meta, {}); // 已知字段不落入自由 meta
});

test('devices：数组形式（仅启用 fake 设备）', () => {
  const fm = parseFrontmatter(`/**
 * @tern
 * title: 录音
 * devices: [mic]
 */
`)!;
  assert.equal(fm.errors.length, 0);
  assert.deepEqual(fm.meta.devices, ['mic']);
});

test('devices：非法形态被拒绝', () => {
  const bad = [
    'devices: [speaker]', // 未知设备名
    'devices:\n  mic: 123', // 非字符串
    'devices: ../etc/passwd && mic', // 标量
    'devices:\n  mic: ../outside.wav', // 相对路径逃逸
    'devices:\n  speaker: x.wav', // 未知字段
  ];
  for (const d of bad) {
    const fm = parseFrontmatter(
      `/**\n * @tern\n * title: t\n * ${d.replace(/\n/g, '\n * ')}\n */\n`,
    )!;
    assert.ok(fm!.errors.length > 0, `应报错: ${d}`);
  }
});

test('depends：合法相对用例列表解析', () => {
  const src = `/**
 * @tern
 * title: 依赖测试
 * depends:
 *   - auth/login-page
 *   - common/setup-db
 *   - deep/nested/case-item
 */
`;
  const fm = parseFrontmatter(src)!;
  assert.equal(fm.errors.length, 0);
  assert.deepEqual(fm.meta.depends, ['auth/login-page', 'common/setup-db', 'deep/nested/case-item']);
  // 已知字段不落入自由 meta
  assert.deepEqual(fm.meta.meta, {});
});

test('depends：非数组被拒绝', () => {
  const fm = parseFrontmatter(`/**
 * @tern
 * title: 测试
 * depends: auth/login-page
 */
`)!;
  assert.ok(fm.errors.some((e) => e.includes('depends 必须是相对用例 ID 的字符串数组')));
  assert.equal(fm.meta.depends, undefined);
});

test('depends：非字符串元素或空字符串被拒绝', () => {
  const bads = [
    'depends: [123]',
    'depends: [""]',
    'depends: ["   "]',
    'depends: [null]',
    'depends: [{ id: "foo" }]',
  ];
  for (const b of bads) {
    const fm = parseFrontmatter(`/**\n * @tern\n * title: t\n * ${b}\n */`)!;
    assert.ok(fm.errors.some((e) => e.includes('depends 数组元素必须是非空字符串')), `应拒绝: ${b}`);
  }
});

test('depends：非法 ID 格式（大写/下划线/路径前后斜杠/扩展名）被拒绝', () => {
  const bads = [
    'depends: [Auth/login]',
    'depends: [auth_login]',
    'depends: [auth/login.spec.ts]',
    'depends: [/auth/login]',
    'depends: [auth/login/]',
    'depends: [auth//login]',
    'depends: [-auth/login]',
  ];
  for (const b of bads) {
    const fm = parseFrontmatter(`/**\n * @tern\n * title: t\n * ${b}\n */`)!;
    assert.ok(fm.errors.some((e) => e.includes('格式非法')), `应拒绝: ${b}`);
  }
});

test('depends：去重与空格修剪', () => {
  const src = `/**
 * @tern
 * title: 去重
 * depends:
 *   - " auth/login "
 *   - auth/login
 */
`;
  const fm = parseFrontmatter(src)!;
  assert.equal(fm.errors.length, 0);
  assert.deepEqual(fm.meta.depends, ['auth/login']);
});

