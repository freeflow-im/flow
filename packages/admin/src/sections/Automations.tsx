// Automations (docs/specs/workspace-admin.md §3.5): the section moved from Chat's admin panel, given the organization's
// members (agents to wake) and the channels the caller is in (where to post or run).
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { adminApi } from '../api';
import { ErrorLine } from '../components/ui';
import { AutomationsSection } from './automations/AutomationsSection';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Automations({ org }: { org: WorkspaceDTO }) {
  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => adminApi.members(org.id) });
  const channels = useQuery({ queryKey: ['channels', org.id], queryFn: () => adminApi.channels(org.id) });
  if (members.isError || channels.isError) return <ErrorLine error={errorText(members.error ?? channels.error)} />;
  if (!members.data || !channels.data) return <p className="text-sm text-muted">Loading…</p>;
  return <AutomationsSection workspaceId={org.id} members={members.data} channels={channels.data} />;
}
