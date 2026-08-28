// Tern 品牌 logo（北极燕鸥 + tern 字标，白底稿抠透明后的鸟形图标）
// 资产与 /logo.png 同源；图标用方形特写 /logo-icon.png，完整横版见 /logo.png
export function TernLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/logo-icon.png"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
      alt="Tern logo"
    />
  );
}
