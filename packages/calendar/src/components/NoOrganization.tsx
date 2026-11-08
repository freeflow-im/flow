// The page for someone in no organization yet: Mail and Calendar are an organization's (platform.md §3.6), so there is nothing to show.
import { Building2 } from 'lucide-react';

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
