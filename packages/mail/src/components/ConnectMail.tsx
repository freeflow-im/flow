// The page before any account is connected.
import { Inbox, Lock, Plus, Server } from 'lucide-react';
import { Button } from './ui/button';

export function ConnectMail({ onAdd }: { onAdd(): void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-primary">
          <Inbox className="size-8" strokeWidth={1.5} />
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-ink">Connect your mail</h1>
        <p className="mb-6 text-sm leading-relaxed text-muted">Read, search and send the mail you already have, right beside your chats and documents. Works with Gmail, iCloud, Outlook, Yahoo, Fastmail and any IMAP server.</p>
        <Button size="lg" onClick={onAdd} className="mx-auto">
          <Plus /> Add a mail account
        </Button>
        <ul className="mt-8 space-y-3 text-left text-[13px] text-muted">
          <li className="flex gap-3">
            <Server className="mt-0.5 size-4 shrink-0" />
            Your mail stays with your provider. FreeFlow connects to it over IMAP and SMTP.
          </li>
          <li className="flex gap-3">
            <Lock className="mt-0.5 size-4 shrink-0" />
            Your password is stored encrypted, only for your account, and you can remove it at any time.
          </li>
        </ul>
      </div>
    </div>
  );
}
