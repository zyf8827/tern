/**
 * @tern
 * title: '登录 - 指定管理员账号（auth: admin）'
 * description: frontmatter 写账号名即换身份；clientId 由运行参数 ADMIN_CLIENT_ID 提供
 * tags: [auth]
 * version: v2
 * module: auth
 * auth: admin
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('管理员账号登录后进入工作台', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toContainText('admin');
});
