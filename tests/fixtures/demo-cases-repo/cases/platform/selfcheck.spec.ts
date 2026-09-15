/**
 * @tern
 * title: 平台自检 - 基础断言链路
 * description: 不依赖外部系统，验证执行链路（bundle/reporter/断言/截图）本身正常
 * tags: [smoke, platform]
 * version: v1
 * module: platform
 * timeout: 60
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('基础断言与控制台输出', async ({ page }) => {
  await page.setContent('<h1 id="hello">Tern 自检 OK</h1>');
  await expect(page.locator('#hello')).toHaveText('Tern 自检 OK');
  console.log('selfcheck passed');
});
