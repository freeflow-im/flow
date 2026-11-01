import { useBoundApi } from '../lib/useBoundApi';
// Profile footer + status picker (design 3a's core interaction): pinned to the
// sidebar bottom; clicking it opens a popover of canned emoji+label statuses.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserDTO } from '@flow/shared';
import { api } from '../lib/api';
import { useAuth, useLive } from '../state';
import { useCapabilities } from '../lib/backend';
import { Avatar } from './Avatar';
import { ProfileModal } from './modals';

/** suppresses: phase 10 DND-family statuses — sets statusSuppressAlerts server-side. */
export const STATUS_OPTIONS: { emoji: string; text: string; suppresses?: boolean }[] = [
  { emoji: '🎧', text: 'Focusing', suppresses: true },
  { emoji: '🗓️', text: 'In a meeting', suppresses: true },
  { emoji: '🌴', text: 'Vacationing' },
  { emoji: '🏠', text: 'Working remotely' },
  { emoji: '🤒', text: 'Out sick' },
  { emoji: '🍽️', text: 'At lunch', suppresses: true },
  { emoji: '💬', text: 'Available' },
  { emoji: '🚫', text: 'Do not disturb', suppresses: true },
];

export default function StatusFooter() {
  const { api } = useBoundApi();
  const auth = useAuth();
  const live = useLive();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = auth.user;
  const caps = useCapabilities();
  const canSetStatus = caps.status.state !== 'unavailable';

  const setStatus = async (emoji: string, text: string, suppresses = false) => {
    setBusy(true);
    try {
      const updated = await api<UserDTO>('PATCH', '/v1/me', {
        statusEmoji: emoji,
        statusText: text,
        statusSuppressAlerts: suppresses,
      });
      auth.setUser(updated);
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative border-t border-white/15 px-3.5 py-3">
      {open && (
        <div
          data-testid="status-picker"
          className="absolute bottom-[74px] left-3 right-3 z-30 rounded-[14px] bg-white p-3 shadow-[0_12px_40px_rgba(20,8,40,.4)]"
        >
          <p className="px-1 pb-1 text-[11px] font-bold tracking-[.05em] text-muted uppercase">Set your status</p>
          {STATUS_OPTIONS.map((o, i) => (
            <button
              key={o.text}
              data-testid={`status-option-${i + 1}`}
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-[9px] p-2 text-left hover:bg-accent/10"
              onClick={() => void setStatus(o.emoji, o.text, o.suppresses)}
            >
              <span className="w-[22px] text-center text-[17px]">{o.emoji}</span>
              <span className="text-[13.5px] font-semibold text-ink">{o.text}</span>
              {o.suppresses && <span className="ml-auto text-[11px] text-faint">pauses notifications</span>}
            </button>
          ))}
          <button
            data-testid="status-clear"
            disabled={busy}
            className="mt-1 w-full border-t border-hairline3 px-2 pt-2 pb-0.5 text-left text-[13px] font-semibold text-faint hover:text-ink"
            onClick={() => void setStatus('', '')}
          >
            Clear status
          </button>
        </div>
      )}

      {menuOpen && (
        <div
          data-testid="avatar-menu"
          className="absolute bottom-[74px] left-3 z-30 rounded-lg bg-white py-1 text-ink shadow-[0_12px_40px_rgba(20,8,40,.4)]"
        >
          <button
            data-testid="avatar-menu-profile"
            className="block w-full px-4 py-1.5 text-left text-sm whitespace-nowrap hover:bg-accent/10"
            onClick={() => { setMenuOpen(false); setShowProfile(true); }}
          >
            Settings…
          </button>
          <button
            data-testid="avatar-menu-signout"
            className="block w-full px-4 py-1.5 text-left text-sm whitespace-nowrap hover:bg-accent/10"
            onClick={auth.signOut}
          >
            Sign Out
          </button>
        </div>
      )}

      <div className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2.5">
        <button
          data-testid="avatar-menu-trigger"
          className="relative shrink-0 rounded-[10px] hover:ring-2 hover:ring-white/30"
          onClick={() => { setMenuOpen((v) => !v); setOpen(false); }}
        >
          <Avatar userId={me.id} name={me.displayName} avatarUrl={me.avatarUrl} size={34} radius={10} />
          {me.statusEmoji && (
            <span
              data-testid="status-avatar-badge"
              className="absolute -right-1.5 -bottom-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-side-bot bg-rail text-[11px]"
            >
              {me.statusEmoji}
            </span>
          )}
        </button>
        <button
          data-testid="status-footer"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-1 text-left hover:bg-white/10 disabled:hover:bg-transparent"
          disabled={!canSetStatus}
          title={canSetStatus ? undefined : caps.status.reason}
          onClick={() => { setOpen((v) => !v); setMenuOpen(false); }}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[13.5px] font-bold text-white">
              <span className="truncate">{me.displayName}</span>
              <span
                data-testid="connection-status"
                title={live.status === 'connected' ? 'Connected' : live.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${live.status === 'connected' ? 'bg-online' : 'bg-orange-400'}`}
              />
            </span>
            <span data-testid="status-footer-label" className="block truncate text-xs text-white/70">
              {me.statusText || (canSetStatus ? 'Set a status' : '')}
            </span>
          </span>
          <span className="text-white/55">▾</span>
        </button>
      </div>

      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
    </div>
  );
}
