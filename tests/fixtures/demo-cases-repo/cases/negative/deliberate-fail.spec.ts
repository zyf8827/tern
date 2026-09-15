/**
 * @tern
 * title: 故意失败用例（失败截图/重试链路验证）
 * description: 断言必然失败，供平台失败处理链路（截图、trace、重试、retry-failed）验证使用
 * tags: [negative]
 * version: v1
 * module: misc
 * auth: none
 * timeout: 60
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('必然失败的断言', async ({ page }) => {
  await page.setContent('<h1>页面正常渲染</h1>');
  await expect(page.locator('h1')).toHaveText('故意不匹配的文本');
  expect(1).toBe(2);
});
