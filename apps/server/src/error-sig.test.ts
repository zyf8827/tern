import test from 'node:test';
import assert from 'node:assert/strict';
import { errorSignature, normalizeErrorLine } from './error-sig.js';

test('数字/时长/UUID/时间戳被归一化，同类失败同签名', () => {
  const a = errorSignature({ message: 'Timeout 30000ms exceeded waiting for selector "#card-12"' });
  const b = errorSignature({ message: 'Timeout 5000ms exceeded waiting for selector "#card-99"' });
  assert.equal(a, b);
  assert.equal(
    errorSignature({ message: 'Request failed with status 500 at 2026-09-17T10:00:00.123Z' }),
    errorSignature({ message: 'Request failed with status 502 at 2026-09-18T23:59:59.999Z' }),
  );
  assert.equal(
    errorSignature({ message: 'load 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed' }),
    errorSignature({ message: 'load 9ab0e8f8-4f89-11d3-9a0c-0305e82c3301 failed' }),
  );
});

test('不同失败不同签名；多行只取首行', () => {
  assert.notEqual(
    errorSignature({ message: 'Timeout 1000ms exceeded' }),
    errorSignature({ message: 'expect(received).toBe(expected)' }),
  );
  assert.equal(
    errorSignature({ message: 'first line\nsecond line 123' }),
    errorSignature({ message: 'first line' }),
  );
});

test('空白压缩、大小写、截断', () => {
  assert.equal(normalizeErrorLine('A  B\t\tc'), 'a b c');
  const long = 'x'.repeat(300);
  assert.ok(normalizeErrorLine(long).length <= 160);
});

test('空 message 用状态兜底', () => {
  assert.equal(errorSignature(null, 'lost'), 'status:lost');
  assert.equal(errorSignature({ message: '' }, 'lost'), 'status:lost');
  assert.equal(errorSignature(null), null);
  assert.ok(errorSignature({ message: 'boom' })!.startsWith('sha1:'));
});
