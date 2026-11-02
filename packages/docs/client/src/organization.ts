// The organization selected in the suite bar, for components (suite.ts' organization state): the home page's two
// roots, the File and row menus' Share with organization / Make private / Move to organization….
import { useSyncExternalStore } from 'react';
import { organizationSnapshot, subscribeOrganization, type OrganizationState } from './suite.ts';

export function useOrganization(): OrganizationState {
  return useSyncExternalStore(subscribeOrganization, organizationSnapshot, organizationSnapshot);
}
