// The page for someone in no organization yet: Mail and Calendar are an organization's (platform.md §3.6), so there is nothing to show.
import { Building2, Loader2, MessageSquare } from 'lucide-react';

export function NoOrganization({ app }: { app: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-white p-8 text-center shadow-sm" data-testid="no-organization">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-primary">
          <Building2 className="size-8" strokeWidth={1.5} />
        </div>
        <p className="mb-6 text-sm leading-relaxed text-muted">You are not in an organization yet. {app} comes with your organization.</p>
        <a href="/" className="text-sm font-semibold text-primary hover:underline">
          Go to Chat
        </a>
      </div>
    </div>
  );
}

/** While the person's account is being provisioned (platform.md §3.4): its mailbox is not there yet. */
export function MailboxSettingUp({ admin = false }: { admin?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-white p-8 text-center shadow-sm" data-testid="mailbox-setting-up">
        <Loader2 className="mx-auto mb-5 size-8 animate-spin text-primary" strokeWidth={1.5} />
        <p className="text-sm font-semibold">Your mailbox is being set up</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">It takes a few moments. This page opens your inbox by itself when it is ready.</p>
        {admin && (
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Taking long? The organization's domain and mail setup are in{' '}
            <a href="/admin/domains" className="font-semibold text-primary hover:underline" data-testid="mailbox-setting-up-admin">
              Admin › Domains &amp; mail
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}

/** A guest's page (docs/specs/workspace-admin.md §6.5): guests use Chat only. */
export function GuestsChatOnly({ app }: { app: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-white p-8 text-center shadow-sm" data-testid="guests-chat-only">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-primary">
          <MessageSquare className="size-8" strokeWidth={1.5} />
        </div>
        <p className="mb-6 text-sm leading-relaxed text-muted">You are a guest in this organization, and guests use Chat only. {app} is for its members.</p>
        <a href="/" className="text-sm font-semibold text-primary hover:underline">
          Go to Chat
        </a>
      </div>
    </div>
  );
}
