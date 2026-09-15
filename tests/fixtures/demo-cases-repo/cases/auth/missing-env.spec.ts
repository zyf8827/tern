/**
 * @tern
 * title: 登录 - 缺少凭据变量（AuthError 指出变量名）
 * description: 'auth: ghost 引用 ${ENV:GHOST_CLIENT_ID}，运行参数未提供时以 AuthError 失败'
 * tags: [auth, negative]
 * version: v2
 * module: auth
 * auth: ghost
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('缺少凭据时用例体不应执行', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toBeVisible();
});
