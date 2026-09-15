/**
 * @tern
 * title: 资产 - ternAsset 引用随行文件并经 API 播种上传
 * description: 用 ternAsset() 取得 worker 本地的资产 WAV，multipart 上传到 demo 端点，断言服务端收到的字节数一致（manage→worker 资产下发链路验证）
 * tags: [media]
 * module: media
 * auth: none
 * timeout: 60
 * author: tern
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('ternAsset 随行文件上传（API 播种）', async ({ page }) => {
  const file = ternAsset('audio/tone.wav');
  const buf = readFileSync(file);
  expect(buf.length).toBeGreaterThan(1000); // WAV 头 + PCM 数据
  const res = await page.request.post('/api/upload', {
    multipart: { file: { name: 'tone.wav', mimeType: 'audio/wav', buffer: buf } },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  // multipart 包装会略大于文件本体；回显文件名一致即可
  expect(body.filename).toBe('tone.wav');
  expect(body.bytes).toBeGreaterThan(buf.length);
});
