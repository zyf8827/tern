/**
 * @tern
 * title: '登录 - 指定审计账号（auth: auditor）'
 * description: '运行级 AUTH_ACCOUNT 只覆盖未写 auth 的用例；写了 auth: auditor 的仍走 auditor'
 * tags: [auth]
 * version: v2
 * module: auth
 * auth: auditor
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('审计账号登录后进入工作台', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toContainText('auditor');
});
