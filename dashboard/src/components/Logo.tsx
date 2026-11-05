/**
 * DataGoat's mark: a friendly goat head in profile on the brand orange. The same artwork is served as
 * /favicon.svg and /brand/logo-mark.svg (static/), so keep them in sync: edit static/brand/logo-mark.svg, then run
 * `node scripts/make-icons.mjs` and copy its shapes here.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" rx="15" fill="#e16540" />
      <path
        d="M27.5 19.5 C25.5 12.5 19.5 9.5 13.5 12"
        fill="none"
        stroke="#1c1917"
        strokeWidth="5.5"
        strokeLinecap="round"
      />
      <g fill="#1c1917">
        <path d="M24.5 26.5 C18.5 25 13 27.5 10 32 C16.5 33.5 21.5 32.5 26 29.5 Z" />
        <path d="M22.5 22 C27 16.5 36 16.5 42 22 C45 25 47.5 29 50.5 31.5 C53.5 34 53 39.5 48.5 40.5 C45 41.3 41.5 41 38.5 42 C35 44.5 30 45 27 42 C22.5 37.5 20.5 29 22.5 22 Z" />
        <path d="M32 41 C33 46.5 32.3 50.5 29.8 54 C35.5 52.3 39.8 48 41 41 Z" />
      </g>
      <circle cx="35.5" cy="27.5" r="2.4" fill="#e16540" />
      <circle cx="48.3" cy="35.2" r="1.1" fill="#e16540" />
    </svg>
  );
}
