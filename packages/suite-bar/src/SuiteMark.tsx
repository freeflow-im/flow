/** The suite's mark: a sheet on the blue square (28px in the bar; the sign-in screens draw it larger). */
export function SuiteMark({ size = 28, title = 'FreeFlow' }: { size?: number; title?: string | null }) {
  const label = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
  return (
    <svg className="sb-mark" width={size} height={size} viewBox="0 0 28 28" {...label}>
      <rect width="28" height="28" rx="7" fill="#1A73E8" />
      <path d="M9 7h7l4 4v10a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" fill="#ffffff" />
      <path d="M16 7v4h4" fill="#CFE0FB" />
      <rect x="11" y="14" width="7" height="1.5" rx=".75" fill="#1A73E8" />
      <rect x="11" y="17" width="5" height="1.5" rx=".75" fill="#1A73E8" />
    </svg>
  );
}
