import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceLaunchArgs } from './runner.js';

test('deviceLaunchArgs: 无 devices 不加任何参数', () => {
  assert.deepEqual(deviceLaunchArgs(undefined, 'http://192.0.2.1:31008'), []);
});

test('deviceLaunchArgs: fake 设备与文件推流参数', () => {
  const args = deviceLaunchArgs({ micFile: '/tmp/a.wav' });
  assert.ok(args.includes('--use-fake-device-for-media-stream'));
  assert.ok(args.includes('--use-file-for-fake-audio-capture=/tmp/a.wav'));
});

test('deviceLaunchArgs: http 非安全源追加 insecure-origin 豁免（getUserMedia 需要 secure context）', () => {
  const args = deviceLaunchArgs({ micFile: '/tmp/a.wav' }, 'http://192.0.2.1:31008');
  assert.ok(args.includes('--unsafely-treat-insecure-origin-as-secure=http://192.0.2.1:31008'));
});

test('deviceLaunchArgs: localhost / https / 带路径的 BASE_URL', () => {
  assert.ok(
    !deviceLaunchArgs({ micFile: '/a' }, 'http://127.0.0.1:8083').some((a) =>
      a.includes('unsafely'),
    ),
  );
  assert.ok(
    !deviceLaunchArgs({ micFile: '/a' }, 'https://example.com').some((a) => a.includes('unsafely')),
  );
  const withPath = deviceLaunchArgs({ micFile: '/a' }, 'http://10.0.0.5:9000/page/');
  assert.ok(withPath.includes('--unsafely-treat-insecure-origin-as-secure=http://10.0.0.5:9000'));
  assert.ok(!deviceLaunchArgs({ micFile: '/a' }, 'not-a-url').some((a) => a.includes('unsafely')));
});
