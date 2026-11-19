// An installed app's icon (docs/specs/user-apps.md §4): its image, from the suite's origin, or its emoji. Nothing when it
// has neither. Inline styles, so it needs no app's stylesheet.
export function AppIcon({ icon, iconUrl, size = 16, className }: { icon?: string | null; iconUrl?: string | null; size?: number; className?: string }) {
  if (iconUrl) return <img src={iconUrl} alt="" width={size} height={size} className={className} style={{ width: size, height: size, flexShrink: 0, borderRadius: 3, objectFit: 'contain', display: 'inline-block' }} data-testid="app-icon" />;
  if (icon) return <span aria-hidden="true" className={className}>{icon}</span>;
  return null;
}
