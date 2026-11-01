// Small outline icon of a shape, for the shape picker and menus.
import { arcPath, polygonPoints, SHAPES, type ShapeKind } from '../../../shared/shapes.ts';

export function ShapeIcon({ kind, size = 20 }: { kind: ShapeKind; size?: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 7, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  let body;
  if (kind === 'rect') body = <rect x="6" y="18" width="88" height="64" {...common} />;
  else if (kind === 'rounded') body = <rect x="6" y="18" width="88" height="64" rx="16" {...common} />;
  else if (kind === 'ellipse') body = <ellipse cx="50" cy="50" rx="44" ry="34" {...common} />;
  else if (kind === 'arc') body = <path d={arcPath(88, 88, 270, 0)} transform="translate(6 6)" {...common} />;
  else if (kind === 'line') body = <line x1="8" y1="78" x2="92" y2="22" {...common} />;
  else if (SHAPES[kind].path) body = <path d={SHAPES[kind].path(88, 88)} transform="translate(6 6)" {...common} />;
  else body = <polygon points={polygonPoints(kind, 88, 88)} transform="translate(6 6)" {...common} />;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      {body}
    </svg>
  );
}
