/**
 * @tern
 * title: 稳定性 - 慢页面（用于取消/实时画面观察）
 * description: 停留 8 秒，供批次取消与 screencast 实时观看测试使用
 * tags: [slow]
 * version: v1
 * module: platform
 * timeout: 120
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('慢页面等待 8 秒', async ({ page }) => {
  await page.setContent('<h1 id="slow">加载中，请稍候…</h1>');
  await page.waitForTimeout(8000);
  await expect(page.locator('#slow')).toBeVisible();
});
