import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCasePath, checkImports, extractAssetRefs, extractImports } from './lint.js';

test('合法路径', () => {
  assert.deepEqual(checkCasePath('portal/login/login-basic.spec.ts'), []);
  assert.deepEqual(checkCasePath('admin/user/user-list.spec.ts'), []);
});

test('非法路径：大写 / 下划线分组 / 扩展名', () => {
  assert.ok(checkCasePath('Portal/login.spec.ts').length > 0);
  assert.ok(checkCasePath('portal/Login_Page.spec.ts').length > 0);
  assert.ok(checkCasePath('portal/login.ts').length > 0);
});

test('import 白名单', () => {
  const imports = extractImports(`
    import { test, expect } from '@playwright/test';
    import { login } from '../_lib/login';
    import fs from 'node:fs';
    import moment from 'moment';
  `);
  assert.deepEqual(checkImports(imports, ['moment']), []);
});

test('未声明依赖被拒绝', () => {
  const imports = extractImports(`import lodash from 'lodash';`);
  assert.ok(checkImports(imports, []).length > 0);
});

test('平台内部模块被拒绝', () => {
  const imports = extractImports(`import { Scheduler } from '@tern/sdk';`);
  const issues = checkImports(imports, []);
  assert.ok(issues.some((i) => i.code === 'IMPORT_PLATFORM'));
});

test('ternAsset 字面量扫描（去重；动态拼接不识别）', () => {
  const src = `
const a = ternAsset('audio/tone.wav');
const b = ternAsset("upload/id.png");
const c = ternAsset('audio/tone.wav');            // 重复
const dyn = ternAsset('audio/' + name);           // 动态拼接：不识别（运行期报错）
`;
  assert.deepEqual(extractAssetRefs(src), ['audio/tone.wav', 'upload/id.png']);
  assert.deepEqual(extractAssetRefs('const x = 1;'), []);
});
