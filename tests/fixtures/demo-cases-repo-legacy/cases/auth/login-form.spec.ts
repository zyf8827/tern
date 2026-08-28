/**
 * @tern
 * title: 登录 - 表单方式（页面用户名密码）
 * description: auth=form-login，worker 先用无头浏览器走登录页表单，再带着登录态执行用例
 * tags: [smoke, auth]
 * version: v2
 * module: auth
 * auth: form-login
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('表单登录后可直接访问受保护页面', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toContainText('欢迎回来');
});
