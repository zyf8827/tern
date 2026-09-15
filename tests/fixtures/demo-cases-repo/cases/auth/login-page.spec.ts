/**
 * @tern
 * title: '登录 - 负向用例（auth: none 不带登录态）'
 * description: '显式 auth: none 的用例不注入会话，访问首页应落在登录页'
 * tags: [auth]
 * version: v2
 * module: auth
 * auth: none
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('未登录访问首页落在登录页', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#login-btn')).toBeVisible();
});
