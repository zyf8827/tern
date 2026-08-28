/**
 * @tern
 * title: 登录 - 接口方式（调登录 API）
 * description: auth=api-login，worker 先 POST 登录接口，Set-Cookie 并入登录态、token 写入 localStorage
 * tags: [auth]
 * version: v2
 * module: auth
 * auth: api-login
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('接口登录后可访问受保护页面且 token 已写入 localStorage', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toContainText('欢迎回来');
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();
});
