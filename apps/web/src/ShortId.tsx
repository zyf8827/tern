import { shortId } from './lib';

/** 短 ID 展示：保留类型前缀 + ULID 前 8 位（如 b_01M2VT6N）；悬停显示完整 ID，点击复制 */
export function ShortId({ id, className }: { id: string | null | undefined; className?: string }) {
  if (!id) return null;
  return (
    <span
      className={`cursor-pointer ${className ?? 'font-mono text-xs text-gray-400'}`}
      title={`${id}（点击复制完整 ID）`}
      onClick={() => void navigator.clipboard?.writeText(id).catch(() => {})}
    >
      {shortId(id)}
    </span>
  );
}
