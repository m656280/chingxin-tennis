/**
 * KnotLogo — placeholder.
 *
 * 暫時用兩個交疊圓圈代表 knot 概念。
 * 之後拿到正式品牌 SVG 時，直接替換這個檔案的內容即可。
 */

interface KnotLogoProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function KnotLogo({
  size = 40,
  color = 'currentColor',
  strokeWidth = 1.2,
}: KnotLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="CHING XIN knot logo"
      role="img"
    >
      <circle cx="20" cy="15" r="7" />
      <circle cx="20" cy="25" r="7" />
    </svg>
  );
}
