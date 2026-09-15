/**
 * @tern
 * title: 登录 - 错误密码提示（中文渲染检查）
 * description: 打开登录页输入错误密码，验证出现中文错误提示（覆盖中文字体渲染场景）
 * tags: [login]
 * version: v1
 * module: auth
 * timeout: 90
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('错误密码显示「用户名或密码错误」', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#username', 'demo-user');
  await page.fill('#password', 'wrong-pass');
  await page.click('#login-btn');
  await expect(page.locator('#message')).toHaveText('用户名或密码错误');
});
