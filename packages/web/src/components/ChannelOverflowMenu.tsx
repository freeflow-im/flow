// The channel header's "⋯" menu (#188). One home on every client for the
// operations that used to be scattered across separate header buttons: the
// channel's shared files (#347), pinned messages, its artifacts, and channel
// options (name, topic, delete).
// The sidebar keeps its own nested artifact rows — this is the in-channel route
// to the same things, and the only one on iOS.
import { useEffect, useRef } from 'react';
import type { ArtifactDTO } from '@flow/shared';
import { artifactGlyph } from '../lib/fileKind';

export default function ChannelOverflowMenu({
  artifacts,
  pinCount,
  showOptions,
  onOpenFiles,
  onOpenPins,
  onOpenArtifact,
  onOpenOptions,
  onInviteVisitor,
  onClose,
}: {
  artifacts: ArtifactDTO[];
  pinCount: number;
  /** DMs have no name/topic/archive — the item is hidden rather than disabled. */
  showOptions: boolean;
  onOpenFiles: () => void;
  onOpenPins: () => void;
  onOpenArtifact: (id: string) => void;
  onOpenOptions: () => void;
  /** "Invite a visitor" (docs/specs/chat-visitors.md §1.1): only for a public channel, a non-guest, and visitors on. */
  onInviteVisitor?: (() => void) | undefined;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss like the members popover next door: click outside, or Esc. The
  // trigger lives outside this node and toggles on its own click, so it's
  // excluded by data attribute rather than by containment.
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (ref.current?.contains(target ?? null)) return;
      if (target?.closest('[data-overflow-trigger]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item = 'flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[13.5px] text-ink hover:bg-accent/10';

  return (
    <div
      ref={ref}
      data-testid="channel-overflow-menu"
      role="menu"
      aria-label="Channel menu"
      className="absolute top-[46px] right-0 z-30 max-h-[70vh] w-60 overflow-y-auto rounded-[14px] bg-white p-2 shadow-[0_12px_40px_rgba(20,8,40,.25)]"
    >
      <button
        type="button"
        role="menuitem"
        data-testid="channel-menu-files"
        className={item}
        onClick={() => { onClose(); onOpenFiles(); }}
      >
        <span aria-hidden>📎</span>
        <span className="flex-1">Files</span>
      </button>

      <button
        type="button"
        role="menuitem"
        data-testid="channel-menu-pins"
        className={item}
        onClick={() => { onClose(); onOpenPins(); }}
      >
        <span aria-hidden>📌</span>
        <span className="flex-1">Pinned messages</span>
        {pinCount > 0 && <span className="text-xs font-semibold text-accent-soft">{pinCount}</span>}
      </button>

      {onInviteVisitor && (
        <button
          type="button"
          role="menuitem"
          data-testid="channel-menu-invite-visitor"
          className={item}
          onClick={() => { onClose(); onInviteVisitor(); }}
        >
          <span aria-hidden>🔗</span>
          <span className="flex-1">Invite a visitor</span>
        </button>
      )}

      <p className="px-2 pt-2 pb-1 text-[11px] font-bold tracking-[.05em] text-muted uppercase">
        Artifacts
      </p>
      {artifacts.length === 0 ? (
        <p className="px-2 pb-1 text-[13px] text-faint">No artifacts yet.</p>
      ) : (
        artifacts.map((a) => (
          <button
            key={a.id}
            type="button"
            role="menuitem"
            data-testid={`channel-menu-artifact-${a.name}`}
            className={item}
            onClick={() => { onClose(); onOpenArtifact(a.id); }}
          >
            <span aria-hidden>{artifactGlyph(a)}</span>
            <span className="truncate">{a.name}</span>
          </button>
        ))
      )}

      {showOptions && (
        <>
          <div className="my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-testid="channel-menu-options"
            className={item}
            onClick={() => { onClose(); onOpenOptions(); }}
          >
            <span aria-hidden>⚙️</span>
            <span>Channel options…</span>
          </button>
        </>
      )}
    </div>
  );
}
