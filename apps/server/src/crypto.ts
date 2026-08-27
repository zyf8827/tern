// 平台侧敏感值加密（docs/platform-enhancements.md §1.4）
// AES-256-GCM；密钥来自 TERN_SECRET_KEY 或自动生成的 data/.secret-key（0600）。
// 密文格式 v1:<iv b64>:<tag b64>:<data b64>，JSON 值序列化后整体加密。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let cachedKey: Buffer | null = null;

/** 解析 32B 主密钥：hex（64 字符）或 base64；非法长度报错 */
export function parseSecretKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('TERN_SECRET_KEY 必须是 32 字节（hex 64 字符或 base64）');
}

/** 取主密钥（进程内缓存）：TERN_SECRET_KEY 优先，否则 data/.secret-key 自动生成 */
export function getSecretKey(dataDir: string): Buffer {
  if (cachedKey) return cachedKey;
  if (process.env.TERN_SECRET_KEY) {
    cachedKey = parseSecretKey(process.env.TERN_SECRET_KEY);
    return cachedKey;
  }
  const file = path.join(dataDir, '.secret-key');
  if (existsSync(file)) {
    cachedKey = parseSecretKey(readFileSync(file, 'utf8'));
    return cachedKey;
  }
  cachedKey = randomBytes(32);
  writeFileSync(file, cachedKey.toString('hex'), { mode: 0o600 });
  return cachedKey;
}

/** 测试用：清缓存 */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}

export function encryptText(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decryptText(enc: string, key: Buffer): string {
  const m = /^v1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(enc);
  if (!m) throw new Error('密文格式非法（期望 v1:<iv>:<tag>:<data>）');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(m[1], 'base64'));
  decipher.setAuthTag(Buffer.from(m[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(m[3], 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

export function encryptJson(obj: unknown, key: Buffer): string {
  return encryptText(JSON.stringify(obj ?? null), key);
}

/** 解密失败（密钥不符/密文损坏）返回 null，由调用方决定回退行为 */
export function decryptJson<T>(enc: string | null | undefined, key: Buffer): T | null {
  if (!enc) return null;
  try {
    return JSON.parse(decryptText(enc, key)) as T;
  } catch {
    return null;
  }
}
