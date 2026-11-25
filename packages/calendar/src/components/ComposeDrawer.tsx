// A new email to someone on an event, beside Calendar: the suite's compose drawer (@flow/suite-bar ComposeDrawer.tsx,
// Mail's composer in a panel on the right). Calendar in Mail's side panel asks Mail instead (PanelApp.tsx), which opens
// its own composer.
import { ComposeDrawer as SuiteComposeDrawer } from '@flow/suite-bar/compose-drawer';

export interface MailTo { email: string; name?: string | null }

export function ComposeDrawer({ to, subject, onClose }: { to: MailTo; subject: string; onClose(sent: boolean): void }) {
  return <SuiteComposeDrawer email={{ to: [{ email: to.email, name: to.name ?? null }], subject }} label={`New email to ${to.name || to.email}`} onClose={onClose} />;
}
