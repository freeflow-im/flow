# Side panel

Status: phases 1 and 2 built 2026-11-13 (web: Mail hosts Calendar, Docs and the anchored assistant). Phase 3 dropped by
the operator; drag and drop (phase 4) and more hosts (phase 5) are next.

## 1. What it is

A panel on the right side of an app that shows another app next to it: in Mail, the person's Calendar or their Docs
files. It works the same in the full Mail tab and in Home > Mail. The person can drag things between the panel and the
app (a file onto an email).

```
┌──────────┬───────────────────────────────┬─┬──────────────────────┐
│ Sidebar  │ Mail (list / thread)          │▐│ [Calendar][Docs][Ada]│
│          │                               │▐│──────────────────────│
│          │                               │▐│  Today · Fri Nov 13  │
│          │                               │▐│  8:00  Stephen call  │
│          │                               │▐│  10:00 ...           │
└──────────┴───────────────────────────────┴─┴──────────────────────┘
                                            ↑ resize handle
```

## 2. How it looks and behaves

- **Closed:** a small pill on the right edge of the window, in the middle top to bottom. It shows one icon per panel
  (Calendar, Docs, and the assistant when it is anchored). Clicking an icon opens the panel on that tab. The pill does
  not collide with the floating assistant pill in the bottom-right corner.
- **Open:** tabs along the top, the panel below, a resize handle on its left edge (Mail's `ResizeHandle`). It pushes the
  app's main area to the left. In a narrow window (below about 1100px) it covers the main area instead.
- **Remembered per app, in this browser:** open or closed, the active tab, the width. Same pattern as
  `useAssistantDockState`.
- **A keyboard shortcut** opens and closes it.
- **One panel per app** (operator ruling 2026-11-13): moving from Mail to Calendar inside Home shows Calendar's own
  panel, in the state Calendar left it.

## 3. Who draws it

The host app draws the panel: one `<SidePanel>` component in `@flow/suite-bar`, used by each host. Home does nothing
for it. So the panel works the same inside Home and in an app's own tab.

## 4. Pluggable: the manifests decide

Two fields on `AppManifest` (`packages/shared/src/manifests.ts`):

```ts
// On the provider: the app can be shown as a panel.
panel: { id: 'calendar', label: 'Calendar', icon: 'calendar', path: '/calendar/panel' }

// On the host: the panels it shows, in this order.
sidePanels: ['calendar', 'docs']
```

A new app becomes pluggable by adding `panel`. Where it appears is decided by adding it to a host's `sidePanels`.

## 5. What each tab shows

- **An app's panel is a frame of that app's panel page:** `/calendar/panel` (an agenda for the day or week),
  `/docs/panel` (recent files and search). Same model as Home's frames: the apps stay separate bundles, each panel uses
  its own app's data and live updates, and a hidden tab's frame is kept so switching back is instant.
- **The assistant tab is the host app's own assistant panel, not a frame**, because each app's assistant has that
  app's tools. The tab shows only while the assistant is anchored. Anchoring (`placement: 'docked'`) now means "a tab
  in the side panel" instead of its own column. Floating stays as it is.

## 6. Messages between the host and a panel

Over `postMessage`, same origin, like `flow:menu`:

| Message | Direction | Use |
| --- | --- | --- |
| `{ type: 'flow:panel:context', v: 1, ref, people?, dates? }` | host → panel | What the host shows now (the open email: its people, the dates it names). Calendar can jump to an invite's date; Docs can show files shared with that person. |
| `{ type: 'flow:open', href }` | panel → host | Exists already. Clicking an event or a file opens it in its own app (inside Home, Home opens it). |

## 7. Drag and drop

One drag type for every app, carrying a `Reference` (`@flow/shared/addresses`):

```
application/x-flow-ref+json  →  { kind: 'file', app: 'docs', id, name, mime }
```

A drop target looks at the kind, not at the app it came from. The frames are on one origin, so a normal HTML5 drag
crosses from the panel's frame into the host.

| Drag | Drop on | Result |
| --- | --- | --- |
| Docs file | Mail compose | Added to the message, as a link or an attachment (§7.1) |
| Docs file | An email in the list or thread | A reply opens with the file added (§7.1) |
| Email | A time in the Calendar panel | A new event with the email's people, filled in (`intent.create('calendar', …)`) |
| Calendar event | Mail compose | The event's details and its `.ics` file |

Mail gets an attachment's bytes from Docs on the server, not through the browser.

### 7.1 Link or attachment

Decided by the recipients' domains (operator ruling 2026-11-13):

- **A link** when every address in To and Cc has the same domain as the address the message is sent from.
- **An attachment** otherwise. This is the default, and the choice when To is empty.
- **Free mail domains never match** (gmail.com, outlook.com, icloud.com and the like): two people at gmail.com are not
  colleagues.
- **The choice follows the recipients** as they are edited, until the person picks one by hand on the file's chip
  ("Link" / "Attachment"). After that, the person's choice stays.
- **A link shares the file** with the recipients (read only) when the message is sent, so a file in the sender's My
  files opens for them too (operator ruling 2026-11-13).

## 8. Clients

Web and Electron. Parity: macOS is a gap to close later; iOS is a deliberate divergence (no room beside the main view).

## 9. Build order

One branch and one PR, one commit per phase:

0. **Spike:** a drag from a frame into its parent in Chrome, Safari and Electron. If Safari drops fail, the fallback is
   a `flow:drag` message relay with a drag image the host draws.
1. `SidePanel` and the manifest fields; Mail as the host; `/calendar/panel` and `/docs/panel`.
2. The assistant as a tab.
3. ~~`flow:panel:context`~~: dropped (operator, 2026-11-13). §6's context message is not built.
4. Drag and drop: the shared type; Docs → Mail (with §7.1), then Mail → Calendar, then Calendar → Mail.
5. More hosts: Docs shows Calendar; Calendar shows Docs and Mail.
