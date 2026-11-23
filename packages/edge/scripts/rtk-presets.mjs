#!/usr/bin/env node
// Makes (or updates) FreeFlow's own RealtimeKit presets on one RTK app (docs/specs/meetings.md §4). Run it once per app,
// after making the app and again when a preset here changes; it is safe to run again:
//
//   RTK_ACCOUNT_ID=… RTK_APP_ID=… RTK_API_TOKEN=… node packages/edge/scripts/rtk-presets.mjs
//
// `flow_guest`, for people who join by a link with no account (Meet phase 3): RTK's own `group_call_guest` sends a
// guest to a waiting room that our room has no button to answer, and ruling R2 says guests go straight in.
// `flow_agent`, for agents sent to a meeting (phase 5). Each starts from an RTK preset and changes only what OURS lists.
const { RTK_ACCOUNT_ID: account, RTK_APP_ID: app, RTK_API_TOKEN: token } = process.env;
if (!account || !app || !token) {
  console.error('Set RTK_ACCOUNT_ID, RTK_APP_ID and RTK_API_TOKEN.');
  process.exit(1);
}
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/realtime/kit/${app}`;

async function rtk(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json?.errors ?? json?.error ?? json)}`);
  return json.data;
}

/** Our presets, each made from one of RTK's own and changing only what is listed. */
const OURS = [
  {
    // Guests by link (Meet phase 3): straight in (R2), no waiting room; they keep the name they typed and do not start or
    // set up plugins.
    from: 'group_call_guest',
    name: 'flow_guest',
    permissions: {
      waiting_room_type: 'SKIP',
      can_edit_display_name: false,
      plugins: { can_close: false, can_start: false, can_edit_config: false, config: {} },
    },
  },
  {
    // Agents sent to a meeting (Meet phase 5): straight in, shown in People (not hidden), with no live transcription
    // (ruling 2026-11-23: agents work from the saved transcript).
    from: 'group_call_participant',
    name: 'flow_agent',
    permissions: { waiting_room_type: 'SKIP', hidden_participant: false, transcription_enabled: false },
  },
];

const presets = await rtk('GET', '/presets');
const named = (name) => presets.find((p) => p.name === name);
for (const ours of OURS) {
  const from = named(ours.from);
  if (!from) throw new Error(`This app has no ${ours.from} preset to start from.`);
  const { permissions, config, ui } = await rtk('GET', `/presets/${from.id}`);
  const preset = { name: ours.name, permissions: { ...permissions, ...ours.permissions }, config, ui };
  const existing = named(ours.name);
  if (existing) {
    await rtk('PATCH', `/presets/${existing.id}`, preset);
    console.log(`updated ${ours.name} (${existing.id})`);
  } else {
    const made = await rtk('POST', '/presets', preset);
    console.log(`made ${ours.name} (${made.id})`);
  }
}
