/**
 * @tern
 * title: 录音 - fake 麦克风文件推流可录到真实音频
 * description: devices.mic 指定资产 WAV 作为虚拟麦克风输入；页面 MediaRecorder 录 3 秒后回显字节数，断言录到非空音频
 * tags: [media]
 * module: media
 * auth: none
 * timeout: 120
 * devices:
 *   mic: audio/tone.wav
 * author: tern
 */
import { test, expect } from '@playwright/test';

test('fake 麦克风文件推流录到真实音频', async ({ page }) => {
  await page.goto('/record');
  await page.locator('#start').click();
  // MediaRecorder 3s 自动停 → 回显 bytes=N
  await expect(page.locator('#result')).toHaveText(/^bytes=\d{4,}$/, { timeout: 30_000 });
  await expect(page.locator('#state')).toHaveText('recording');
});
