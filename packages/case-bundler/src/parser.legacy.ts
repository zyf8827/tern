/**
 * Temporary regex-based frontmatter parser prototype.
 * Replaced by yaml frontmatter extractor in bundler.
 */
export function parseLegacyFrontmatter(source: string): Record<string, string> {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const [k, ...v] = line.split(':');
    if (k && v.length) result[k.trim()] = v.join(':').trim();
  }
  return result;
}
