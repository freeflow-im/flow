// The sidebar's colors on the web client. The workspace presets are shared with the native apps (@flow/shared
// theme.ts), but under the suite bar (packages/suite-bar) the default one, design 3a's violet, is drawn as the suite's
// navy: a workspace that never picked a color has the default stored, and the suite is blue now. A workspace that
// picked another preset keeps it.
import { DEFAULT_SIDEBAR_COLOR, SIDEBAR_COLORS, sidebarColor, type SidebarColor } from '@flow/shared';

export const SUITE_NAVY: SidebarColor = { id: DEFAULT_SIDEBAR_COLOR, name: 'Navy (default)', top: '#27365C', bottom: '#1E2A4A', rail: '#1A2442' };

/** The colors the web client draws for a workspace's preset id. */
export function webSidebarColor(id: string | undefined | null): SidebarColor {
  const color = sidebarColor(id);
  return color.id === DEFAULT_SIDEBAR_COLOR ? SUITE_NAVY : color;
}

/** The presets as the appearance picker shows them, the default as it is drawn. */
export const WEB_SIDEBAR_COLORS: SidebarColor[] = SIDEBAR_COLORS.map((c) => webSidebarColor(c.id));
