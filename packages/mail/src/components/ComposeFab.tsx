// The floating "New message" button over the lower-left corner of the message list, where Mail shows no folder
// sidebar (inside Home, and on a phone-sized screen) and so no Compose button. Drawn like the assistant's launcher
// pill (@flow/suite-bar assistant-dock.css): its accent, height, shadow and inset, icon only.
import { SquarePen } from 'lucide-react';

export function ComposeFab({ onCompose }: { onCompose(): void }) {
  return (
    <button
      type="button"
      onClick={onCompose}
      aria-label="New message"
      title="New message (c)"
      data-testid="compose-fab"
      className="absolute bottom-6 left-6 z-20 flex size-10 items-center justify-center rounded-full border border-[#1a73e8] bg-[#1a73e8] text-white shadow-[0_1px_2px_rgba(16,24,40,0.06),0_18px_48px_-8px_rgba(16,24,40,0.28)] transition-colors hover:bg-[#1765cc] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a73e8]"
    >
      <SquarePen className="size-[18px]" strokeWidth={2} aria-hidden />
    </button>
  );
}
