/**
 * @tern
 * title: 登录 - 未授权设备（业务失败仍 HTTP 200）
 * description: 'auth: broken 对应的 clientId 未绑定账号，mock-login 返回 success:false；
 *              平台应记 AuthError（含 msg）而不是开始跑用例'
 * tags: [auth, negative]
 * version: v2
 * module: auth
 * auth: broken
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('登录失败时用例体不应执行', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toBeVisible();
});
