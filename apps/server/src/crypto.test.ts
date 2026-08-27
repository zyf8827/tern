import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  encryptJson,
  decryptJson,
  encryptText,
  decryptText,
  getSecretKey,
  parseSecretKey,
  resetSecretKeyCache,
} from './crypto.js';

test('加解密 roundtrip（文本与 JSON）', () => {
  const key = Buffer.alloc(32, 7);
  const enc = encryptText('demo session_token=abc123', key);
  assert.match(enc, /^v1:/);
  assert.equal(decryptText(enc, key), 'demo session_token=abc123');

  const obj = { CLIENT_ID: 'x\u00a0y', BASE_URL: 'http://a', n: 1 };
  assert.deepEqual(decryptJson(encryptJson(obj, key), key), obj);
});

test('错误密钥解密返回 null / 抛错', () => {
  const enc = encryptText('secret', Buffer.alloc(32, 1));
  assert.throws(() => decryptText(enc, Buffer.alloc(32, 2)));
  assert.equal(decryptJson(encryptJson({ a: 1 }, Buffer.alloc(32, 1)), Buffer.alloc(32, 2)), null);
  assert.equal(decryptJson(null, Buffer.alloc(32, 1)), null);
  assert.equal(decryptJson('not-a-cipher', Buffer.alloc(32, 1)), null);
});

test('每次加密产生不同密文（随机 IV）', () => {
  const key = Buffer.alloc(32, 3);
  assert.notEqual(encryptText('same', key), encryptText('same', key));
});

test('密钥来源：TERN_SECRET_KEY / 自动生成文件', () => {
  resetSecretKeyCache();
  const dir = mkdtempSync(path.join(tmpdir(), 'tern-crypto-'));
  const k1 = getSecretKey(dir);
  resetSecretKeyCache();
  const k2 = getSecretKey(dir); // 第二次从文件读
  assert.deepEqual(k1, k2);
  assert.equal(k1.length, 32);
  resetSecretKeyCache();
  process.env.TERN_SECRET_KEY = 'ab'.repeat(32);
  assert.deepEqual(getSecretKey(dir), Buffer.from('ab'.repeat(32), 'hex'));
  delete process.env.TERN_SECRET_KEY;
  resetSecretKeyCache();
});

test('parseSecretKey 校验长度', () => {
  assert.throws(() => parseSecretKey('short'));
  assert.throws(() => parseSecretKey('zz'.repeat(32))); // 非 hex
  assert.equal(parseSecretKey('cd'.repeat(32)).length, 32);
});
