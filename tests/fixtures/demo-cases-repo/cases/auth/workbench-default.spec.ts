/**
 * @tern
 * title: 登录 - 默认账号（不写 auth 走项目默认配方）
 * description: 不写 auth 的用例自动携带默认登录态（api mockLogin + default 账号）进入工作台
 * tags: [smoke, auth]
 * version: v2
 * module: auth
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('默认账号登录后进入工作台', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toContainText('demo-user');
});
