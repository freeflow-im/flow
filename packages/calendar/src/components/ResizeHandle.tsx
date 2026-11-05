import type { PointerEvent as ReactPointerEvent } from 'react';

/** The draggable right edge of a panel: a hairline that turns blue under the pointer. */
export function ResizeHandle(props: {
  label: string;
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
  onDoubleClick(): void;
}) {
  const { label, ...handlers } = props;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize, double-click to reset"
      className="group relative z-10 -ml-[3px] w-[6px] shrink-0 cursor-col-resize touch-none"
      {...handlers}
    >
      <div className="absolute inset-y-0 left-[2px] w-[2px] bg-transparent transition-colors group-hover:bg-primary/60 group-active:bg-primary" />
    </div>
  );
}
