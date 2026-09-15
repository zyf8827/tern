/**
 * @tern
 * title: 登录 - 会话失效后重登（validate 链路）
 * description: 本用例登录后主动吊销自己的 session_token；同 run 后续用例复用缓存时
 *              validate（findUserLoginInfo）失败 → 按原配方重新登录
 * tags: [auth]
 * version: v2
 * module: auth
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('登录后吊销自身会话', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toContainText('demo-user');
  const resp = await page.context().request.post('/api/auth/_expire');
  expect(resp.ok()).toBeTruthy();
});
