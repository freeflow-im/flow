// The pages with nothing to administer: someone in no organization, and a member who is not an owner or admin
// (docs/specs/workspace-admin.md §2: they see Automations alone once it moves in; until then, this).
import type { ReactNode } from 'react';
import { Building2, ShieldCheck } from 'lucide-react';

function Page({ icon, text, testid }: { icon: ReactNode; text: string; testid: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-white p-8 text-center shadow-sm" data-testid={testid}>
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-primary">{icon}</div>
        <p className="mb-6 text-sm leading-relaxed text-muted">{text}</p>
        <a href="/" className="text-sm font-semibold text-primary hover:underline">
          Go to Chat
        </a>
      </div>
    </div>
  );
}

export const NoOrganization = () => <Page icon={<Building2 className="size-8" strokeWidth={1.5} />} text="You are not in an organization yet. Admin is where an organization's owner and admins set it up." testid="no-organization" />;

export const NotAllowed = ({ name }: { name: string }) => (
  <Page icon={<ShieldCheck className="size-8" strokeWidth={1.5} />} text={`Only ${name}'s owner and admins can change its settings.`} testid="not-allowed" />
);
