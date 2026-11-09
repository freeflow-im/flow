// The app's address: `/admin` or `/admin/<section>` (docs/specs/workspace-admin.md §2). The sections an app build has
// are a subset of @flow/shared's ADMIN_SECTIONS while the rest move in (§8); an unknown or missing one is the first.
import { ADMIN_SECTIONS, adminAddress, type AdminSection } from '@flow/suite-bar';

/** The sections this build of the app has, in the order the list shows them. */
export const SECTIONS: readonly AdminSection[] = ['general', 'domains'];

export const SECTION_LABELS: Record<AdminSection, string> = {
  general: 'General',
  members: 'Members',
  domains: 'Domains & mail',
  agents: 'Agents & apps',
  automations: 'Automations',
};

/** The section a pathname names, or the first one. */
export function sectionOf(pathname: string, sections: readonly AdminSection[] = SECTIONS): AdminSection {
  const m = /^\/admin\/?([a-z-]*)/.exec(pathname);
  const name = m?.[1] ?? '';
  return (ADMIN_SECTIONS as readonly string[]).includes(name) && sections.includes(name as AdminSection) ? (name as AdminSection) : sections[0]!;
}

export const sectionPath = (section: AdminSection): string => adminAddress(section);
