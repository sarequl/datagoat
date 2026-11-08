/**
 * DataGoat's mark: three rounded bars, the last one curling into a goat horn at the peak.
 * "tile" is the app icon (white bars on the brand orange), the same artwork as /favicon.svg and
 * /brand/logo-mark.svg; "plain" is the bars alone in brand tints (/brand/logo.svg), for the top bar.
 * Keep them in sync: edit static/brand/logo-mark.svg and logo.svg, run
 * `node scripts/make-icons.mjs`, and copy the shapes here.
 */
const HORN = "M40 46V32C40 22 47 16.5 58 15C52.5 24.5 52 28 52 32V46a6 6 0 0 1-12 0Z";

export function LogoMark({
  size = 28,
  className,
  variant = "tile",
}: {
  size?: number;
  className?: string;
  variant?: "tile" | "plain";
}) {
  const tile = variant === "tile";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      data-variant={variant}
    >
      {tile ? <rect width="64" height="64" rx="15" fill="#e16540" /> : null}
      <rect
        x="10"
        y="35"
        width="12"
        height="17"
        rx="6"
        fill={tile ? "#ffffff" : "#f3c2b2"}
        fillOpacity={tile ? 0.5 : 1}
      />
      <rect
        x="25"
        y="17"
        width="12"
        height="35"
        rx="6"
        fill={tile ? "#ffffff" : "#eb9578"}
        fillOpacity={tile ? 0.75 : 1}
      />
      <path d={HORN} fill={tile ? "#ffffff" : "#e16540"} />
    </svg>
  );
}
