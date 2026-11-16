#!/usr/bin/env node
// Makes (or updates) FreeFlow's own RealtimeKit presets on one RTK app (docs/specs/meetings.md §4). Run it once per app,
// after making the app and again when a preset here changes; it is safe to run again:
//
//   RTK_ACCOUNT_ID=… RTK_APP_ID=… RTK_API_TOKEN=… node packages/edge/scripts/rtk-presets.mjs
//
// For now there is one: `flow_guest`, for people who join by a link with no account (Meet phase 3). RTK's own
// `group_call_guest` sends a guest to a waiting room that our room has no button to answer, and ruling R2 says guests
// go straight in. It starts from that preset and changes only what is listed in GUEST below.
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

/** What `flow_guest` changes from RTK's `group_call_guest`. */
const GUEST = {
  name: 'flow_guest',
  permissions: {
    // Straight in (R2): no waiting room.
    waiting_room_type: 'SKIP',
    // A guest keeps the name they typed, and does not start or set up plugins.
    can_edit_display_name: false,
    plugins: { can_close: false, can_start: false, can_edit_config: false, config: {} },
  },
};

const presets = await rtk('GET', '/presets');
const named = (name) => presets.find((p) => p.name === name);
const from = named('group_call_guest');
if (!from) throw new Error('This app has no group_call_guest preset to start from.');
const { permissions, config, ui } = await rtk('GET', `/presets/${from.id}`);
const preset = { name: GUEST.name, permissions: { ...permissions, ...GUEST.permissions }, config, ui };

const existing = named(GUEST.name);
if (existing) {
  await rtk('PATCH', `/presets/${existing.id}`, preset);
  console.log(`updated ${GUEST.name} (${existing.id})`);
} else {
  const made = await rtk('POST', '/presets', preset);
  console.log(`made ${GUEST.name} (${made.id})`);
}
