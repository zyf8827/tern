/**
 * @tern
 * title: 多维筛选 - 版本 v1.5 专有用例
 * description: 用于 version/module 多维度筛选验证
 * tags: [misc]
 * version: v1.5
 * module: misc
 * timeout: 60
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('v1.5 专属断言', async ({ page }) => {
  await page.setContent('<span id="v">v1.5</span>');
  await expect(page.locator('#v')).toHaveText('v1.5');
});
