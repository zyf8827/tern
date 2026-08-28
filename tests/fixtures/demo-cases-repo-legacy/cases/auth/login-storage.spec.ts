/**
 * @tern
 * title: 登录 - 直写 storage（cookie/localStorage 注入）
 * description: auth=storage-login，worker 直接按声明构造 storageState（适合长期 token）
 * tags: [auth]
 * version: v2
 * module: auth
 * auth: storage-login
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('注入会话 cookie 后可访问受保护页面', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toContainText('欢迎回来');
});
