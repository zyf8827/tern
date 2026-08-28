export const PAGE_SIZE = 20;

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const page = Math.floor(offset / Math.max(1, limit)) + 1;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  return (
    <div className="flex items-center gap-2 mt-3 text-sm text-gray-600">
      <span>共 {total} 条</span>
      <span className="text-gray-400">每页 {limit} 条</span>
      <button
        className="px-2 py-0.5 border rounded disabled:opacity-40"
        disabled={page <= 1}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        上一页
      </button>
      <span>
        {page} / {pages}
      </span>
      <button
        className="px-2 py-0.5 border rounded disabled:opacity-40"
        disabled={page >= pages}
        onClick={() => onChange(offset + limit)}
      >
        下一页
      </button>
    </div>
  );
}
