# Workspace admin (2026-11-09)

Status: Draft for Scott's review · Platforms: web (the admin surface is web-only: decision_log, "App-management UI is
web-only" and "Invite an Agent is web-only admin surface")

One screen where a workspace's owner and admins set the workspace up and keep it running: its name and look, who may
join and how, the members and their accounts, the domains and the mail on them, the agents, the automations. Today
these jobs are spread over the admin panel's three tabs (`AdminView.tsx`: Organization, Domains, Automations) and
five modals reached from the workspace menu (Invite People with the Google self-registration toggle, Agents,
Workspace appearance, Custom emoji) plus the Directory's broadcast email. Domain setup stops half way: an admin can
add and verify a domain, but nothing in the UI makes the domain at the mail provider or shows its DKIM record, so
mail on an organization's own domain cannot be turned on without an API call. This spec collects the settings into
one place and finishes the domain flow. It builds on `platform.md` §3.1 (policies), §3.2 (domains), §3.3 (accounts)
and §3.4 (provisioning); the server pieces mostly exist, and the list of API changes (§6) is short.

## 1. Goals and non-goals

Goals:

- One entry in the workspace menu, **Workspace settings…**, opens one screen with sections. The scattered modals
  and tabs become sections of it; the menu loses "Manage users", "Workspace appearance…" and "Custom emoji…".
- An admin can take a domain from "typed in" to "mail works on it" from the screen alone, with each step telling
  them what to publish in DNS, whether it is there yet, and what is left.
- An admin can see every account's mail state (ready, being set up, stopped and why, none for a guest) and retry one
  that stopped.
- Every setting the server already has a field for is on the screen: the four policies, Google self-registration,
  link previews, the join link, the sidebar color and icon, custom emoji.
- Deep links: another surface (Mail's "your organization has no mailboxes yet", an admin notice in Chat) can open
  the screen at a section.

Non-goals (v1):

- Native clients. The macOS and iOS apps keep their member list and stay out of admin; `CHANGELOG.md` Parity keeps
  the line. A "Workspace settings (opens the web app)" menu item is a later nicety.
- Billing, plans and quotas. Nothing is metered yet.
- Moving existing addresses to a new primary domain (§4.6 says why).
- Per-organization mail retention. The sweep reads `MAIL_RETENTION_DAYS` for every organization; the screen shows it,
  does not set it.
- Audit log. Admin actions are events on the bus already (`platform.md` §5.2); a page that lists them is later.

## 2. Who sees what, and how it opens

| Caller | Sees |
| --- | --- |
| owner | every section, plus **Transfer ownership** and **Delete workspace** |
| admin | every section but those two |
| member (including guests) | **Automations** only, as today |
| agent, app | nothing; the menu entry is not drawn |

The screen takes the content pane, as the admin panel does today (`Main.tsx` renders `<AdminView>` in place of the
message stream; `sel.openAdminPanel()`). It is reached from:

- the workspace menu: **Workspace settings…** (owner, admin) and **Automations** (everyone), two entries where there
  were five;
- a hash deep link `#/admin/<section>` (`general`, `members`, `domains`, `agents`, `automations`), which generalizes
  today's `requestAdminTab(tab)`; an unknown or disallowed section falls back to the first one the caller may see;
- notices: a provisioning failure notice ("Could not set up a mailbox for …") links to `#/admin/members`; Mail's
  empty state for a hosted-mail organization with no domain ready links to `#/admin/domains`.

## 3. Layout

The header keeps today's shape: title, the workspace name under it, **Close** at the right. Under it a section list
on the left (a row of tabs on a narrow screen, as the three tabs are today) and the section's page on the right, one
scrolling column of cards, 48rem wide at most, the width the admin panel uses now.

Every control saves when it changes, the pattern `OrganizationSection` has: a `busy` flag disables the card, an
error line appears under the control that failed, the lists refetch. Destructive actions confirm inline ("Remove
example.com? **Remove** · Cancel"), never in a browser dialog. Nothing on the screen has a Save button.

Sections, in order:

1. **General** — name, icon and color, custom emoji, joining, agents policy, sharing policy, link previews
2. **Members** — the roster with roles, kinds and mail state; invitations
3. **Domains & mail** — the domains with their setup steps; the mail summary
4. **Agents & apps** — the shared agents and their sponsors; the installed apps
5. **Automations** — unchanged (`AutomationsSection.tsx`)

Owner-only actions sit at the end of General, under a rule: **Transfer ownership**, **Delete workspace**.

### 3.1 General

| Control | Backing | Today |
| --- | --- | --- |
| Name | `PATCH /v1/workspaces/:id { name }` (new field, §6.1) | not editable anywhere |
| Slug, read-only, shown as `<slug>.freeflow.im` with "Addresses depend on it, so it cannot change" | `WorkspaceDTO.slug` | shown nowhere |
| Icon (upload, remove) and sidebar color (the preset row) | `POST/DELETE …/avatar`, `PATCH { sidebarColor }` | Workspace appearance modal |
| Custom emoji: the table with add and remove | `GET/POST/DELETE …/emoji` | Custom emoji modal |
| Who can invite people: every member / owners and admins | `policies.inviteBy` | Organization tab |
| Join link: on/off, the link with Copy, Reset | `GET/POST/DELETE …/join-link` | inside Invite People |
| Google self-registration: "Anyone with a Google account at `<domain>` may join" | `googleSelfRegisterDomain` | a toggle inside Invite People, shown only to an admin signed in with Google on a non-consumer domain |
| Who can add agents: every member / owners and admins | `policies.agentsBy` | Organization tab |
| Allow sharing by link | `policies.linkSharing` | Organization tab |
| Link previews: on/off, and the domain allowlist (one per line, empty = any) | `unfurlEnabled`, `unfurlDomainAllowlist` | the fields exist on the row; no admin UI |

The Google self-registration control keeps today's rule: the domain offered is the one the signed-in admin's Google
account is on (`useSelfRegisterDomain`), and the server re-checks it. Offering any verified domain of the organization
comes later (ruling 7, §10).

There is no "new members join as" setting. Whoever joins, by invitation, join link or Google self-registration, is a
native member with an address and a mailbox (ruling 6). A guest is made by a separate action in Members (§3.2) or by
changing an existing member's kind.

### 3.2 Members

The roster table from the Organization tab, with these changes:

- **Invite people** button at the top (opens today's Invite People dialog, minus the join link and the Google toggle,
  which moved to General). Everyone invited this way becomes a native member.
- **Invite a chat guest**, a second, smaller button beside it. A guest invitation makes a guest account when it is
  accepted (§6.5): no address, no mailbox, and the suite bar shows Chat alone. The dialog says so in one line
  ("Guests use Chat only. They get no address and no mailbox here.") so nobody invites a colleague as a guest by
  mistake. Guests are for people from outside the organization who are in its conversations: a client, a contractor,
  the other side of a project.
- Under both, **Pending invitations**: email, kind (member or guest), who invited, when, with **Revoke** (new
  endpoints, §6.3). Today an invitation, once sent, is invisible to admins.
- Filter chips: **All · People · Agents · Guests · Needs attention**. "Needs attention" is every account whose state
  is not `active` or that carries a `statusMessage`.
- A **Mail** column beside Kind, from the account (`GET …/accounts`): "ready" (hosted mailbox exists and the account
  is active), "being set up" (`requested`, `mailbox_ready`, `calendars_ready` with no message), "stopped: <message>"
  (a `statusMessage`, in amber, the message as the provider gave it), "—" for a guest. Needs `hosted` on the DTO
  (§6.2). Hidden when hosted mail is off (`GET /v1/config` `hostedMail` false), as the mailbox controls are today.
- Actions per row: role (owner and admin only; the owner's row has none), kind (native/guest, as today, never for
  the owner or an agent), **Retry setup** when the Mail column says stopped (§6.4), **Remove** with inline confirm.
- The two bulk actions stay, under the table: **Set up mailboxes for everyone** (with its "N native accounts; guests
  get none" count) and **Make every member a guest** (with its confirm text). Both exist today.

### 3.3 Domains & mail

Two parts: a **Mail** summary card, then one card per domain. Section 4 is the domain card in detail.

The Mail card, when hosted mail is on:

- "Mailboxes are provided by FreeFlow at `<primary domain>`" and the provider's IMAP/SMTP host (from
  `mailSettings`, so a person can set up a mail client), or "Hosted mail is off on this server" when it is not.
- Counts: native accounts, mailboxes ready, being set up, stopped (the same numbers the Members filters give).
- "A removed member's mailbox is kept for 30 days, then deleted" (`MAIL_RETENTION_DAYS`, shown, not set).
- **Add a domain**: the input and button from today's Domains tab.

### 3.4 Agents & apps

The Agents modal's list, as a card: name with the 🤖 mark, sponsor, since when, **Remove** with confirm; **Invite an
agent** opens today's `InviteAgentModal`. The apps card is the installed apps list that Manage Apps shows, unchanged,
embedded; app management itself (scopes, tokens) stays in its dialog. The menu's **Agents** entry goes; the Agents
modal component stays for the sidebar's invite flow.

### 3.5 Automations

As today. The only change is the route: `#/admin/automations`.

## 4. The domain card

Each of the organization's domains is one card. The card's job is to say **where the domain is on the way to
working mail** and **what to do next**, with nothing else competing for attention.

### 4.1 The steps

An organization's own domain goes through five steps. The card shows them as a numbered list; done steps are
collapsed to one line with a check mark, the current step is open, later steps are grey.

| Step | What the admin does | What the server knows | Done when |
| --- | --- | --- | --- |
| 1 Add | types the domain | `addDomain`: a row with a fresh token | the card exists |
| 2 Prove ownership | publishes TXT `_freeflow.<domain>` = `freeflow-verify=…`, presses **Verify** | `verifyDomain` looks the TXT up | `verified` |
| 3 Publish the mail records | publishes the provider's ownership TXT, the MX records, SPF, DMARC | `describeDomains` checks each (`status`) | every record but DKIM is `present` |
| 4 Turn on mail | presses **Turn on mail for this domain** | `setDomainDkim`: the domain is made at the provider, the DKIM record comes back | `atProvider` (§6.2) |
| 5 Publish DKIM | publishes the DKIM TXT (`x._domainkey.<domain>` on MXRoute) | `describeDomains` checks it | the DKIM record is `present` |

Then, optionally, **Make primary**: new addresses are made on this domain from then on. Existing addresses stay
(§4.6).

The badge in the card's header follows the steps: **not verified** (amber) → **verified** (green) → **mail ready**
(green, step 5 done) ; **primary** beside it when it is. Today's header already has the first two.

Step 3 before step 4 is not a presentation choice. MXRoute refuses to add a domain whose `_da-verify-…` TXT it cannot
see (`mxroute.ts` returns `pending`), so the records must be in DNS first. The provisioning path learned this the hard
way (`steps.ts`: platform DNS is published before `createDomain`); the card makes the order visible to a person.

### 4.2 The records table

The table from today's Domains tab (Type, Name, Value, In DNS, Copy), grouped and labelled by purpose, in the order
`recordsFor` gives them:

| Purpose | Shown as | Appears |
| --- | --- | --- |
| `verification` | "Ownership (FreeFlow)" | from step 1, under step 2 |
| `provider` | "Ownership (mail provider)" | from step 1, under step 3 |
| `mx` | "Mail routing" | under step 3 |
| `spf` | "Sender policy" | under step 3 |
| `dmarc` | "DMARC" | under step 3 |
| `dkim` | "Signing (DKIM)" | after step 4, under step 5 |

Each row keeps its In DNS cell: "✓ present", "missing", or "—" when the server did not check. **Check again** sits
under the table; the server reuses a check for a minute and `?refresh=1` looks again unless the last look is only
seconds old (`DOMAIN_STATUS_TTL`, `DOMAIN_STATUS_MIN_AGE`), so the button says "Checked just now" and disables for
those seconds rather than pretending to look.

The table gets one help line per DNS host family, not a wizard: "At your DNS host, add each record with the name
and value shown. Some hosts want the name without the domain (`_freeflow` instead of `_freeflow.example.com`)."

### 4.3 Turn on mail

The button is enabled when the domain is verified and the provider's ownership TXT is present. Otherwise it is
disabled with the reason beside it ("Publish the mail provider's ownership record first"). Pressing it calls
`POST …/domains/:domain/dkim`. Outcomes:

| Server answer | Card shows |
| --- | --- |
| 200 with the record | step 4 checked; the DKIM row appears under step 5 with In DNS "missing" until it is published |
| 409 `pending` (the provider could not see the TXT yet) | "The mail provider cannot see the ownership record yet. DNS can take a while; try again in a few minutes." |
| 409 `dkim_pending` (MXRoute has the domain but no key yet) | "The key is being made; try again in a minute." Step 4 is checked (the domain exists at the provider). |
| 409 `domain_unverified` | cannot happen from the UI (the button is disabled); shown as the message if it does |
| 502 / 503 (provider down, rate limited) | the message, with **Try again** |

Pressing it again on a domain that has mail replaces nothing on MXRoute (the key is the provider's) and rotates the
key on a provider we manage keys for (OpenSRS). The button therefore reads **Turn on mail for this domain** until
step 4 is done and **Renew the signing key** after, with an inline confirm on the second.

### 4.4 The platform domain

`<slug>.freeflow.im` is one card, badged **managed by FreeFlow**, with no steps: "FreeFlow publishes this domain's
records. Mail on it works as soon as the first mailbox is set up." Its records table is read-only with In DNS
reading "published" for every row we have written (the zone is ours; today the DTO's `status` is empty for it, and
stays so; the client shows "published" from `kind === 'platform'`). The DKIM row appears once the domain exists at
the provider: provisioning the first native account does that (`steps.ts` republishes after `createDomain`), and so
does **Turn on mail** on this card, which is offered when `atProvider` is false so an admin need not wait for a
member to join. **Make primary** is offered when it is not primary; **Remove** never is.

### 4.5 Remove

Offered on an own domain that is not primary. The server refuses when accounts have addresses on it
(`domain_in_use`: removed members' kept addresses count, so a domain in use stays until the retention period has
passed); the card says "Accounts have addresses on this domain" and lists nothing more. A verified domain that was
`atProvider` is left at the provider; cleaning it up there is a later job (§9).

### 4.6 What primary means, and does not

Making a domain primary changes where **new** addresses are made. Nobody's existing address moves: an address is
the account's name inside the organization, other people's contacts and mail threads carry it, and the mailbox at
the provider is keyed by it. The card says so under the button, as the Domains tab does today. A "move everyone to
the new domain" tool, with aliases on the old addresses, is a later phase and needs provider support for aliases.

## 5. The Members section and provisioning

The Mail column and **Retry setup** are the admin's window on `platform.md` §3.4. The states map as:

| Account | Mail column |
| --- | --- |
| `kind = guest` | — |
| `active`, `hosted` | ready |
| `requested` / `mailbox_ready` / `calendars_ready`, no message | being set up |
| any state with `statusMessage` | stopped: `<message>` and **Retry setup** |
| `active`, not `hosted`, hosted mail on | no mailbox yet, **Set up** (the same call as Retry) |
| `suspended` | suspended |

**Retry setup** calls the new per-account endpoint (§6.4), which queues one `provision` message, the same work
**Set up mailboxes for everyone** queues for all. The row shows "being set up" at once and the list refetches when
the account's state changes (the admin panel already refetches on member events; an `account.state` event on the bus
is the clean trigger and exists for the notices).

## 6. API and type changes

All on the Worker. Owner or admin unless said.

### 6.1 Workspace name

`PATCH /v1/workspaces/:id` accepts `name` (1 to 80 characters after trimming). `updateWorkspace` gains the field; the
`workspace.updated` frame the Org object already sends carries the new name to every client. The slug does not
change; it is in addresses.

### 6.2 Domain and account DTOs

```ts
export interface DomainDTO {
  // …as today, plus:
  /** The domain exists at the mail provider (step 4 of the setup, §4.1). */
  atProvider: boolean;
}

export interface AccountDTO {
  // …as today, plus:
  /** The account's hosted mailbox exists (provisioning's mailbox step is done). Absent when hosted mail is off. */
  hosted?: boolean;
}
```

`describeDomains` reads `domain_at_provider` from the row it already has; `listAccounts` joins the hosted flag the
directory keeps (`setHosted`). No migration.

### 6.3 Pending invitations

- `GET /v1/workspaces/:id/invites` → `{ invites: InviteDTO[] }`: the workspace's open invitations (not accepted, not
  declined, not expired), newest first, with `email`, `invitedBy` (display name), `createdAt`, `expiresAt`.
- `DELETE /v1/workspaces/:id/invites/:inviteId`: revokes one; the link in the email stops working.

The Org object owns invitations (`services/workspaces.ts` `createInvites`, `acceptInvite`, `declineInvite`); both
routes go beside them. `InviteDTO` exists in `@flow/shared` and is returned by `POST …/invites` today.

### 6.4 One account's provisioning

`POST /v1/workspaces/:id/accounts/:accountId/provision` → `{ queued: boolean }`. Owner or admin; the account must be
the organization's and not `removed`. It calls the directory's `provisionAccount` (added 2026-11-09 for the
edge-secret admin route, which stays for operators). A guest answers 409 `guest`: guests get no mailbox.

### 6.5 Guest invitations

`POST /v1/workspaces/:id/invites` takes `kind?: 'native' | 'guest'` (default `native`); `InviteDTO` carries `kind`.
`acceptInvite` passes the invitation's kind to `accountForJoin`, which today reads the organization's
`defaultAccountKind` policy; the join link and Google self-registration always pass `native`. The owner and agents
stay native whatever is asked (the existing rule). The policy field `defaultAccountKind` is retired: the client stops
showing it, the server reads it as `native`, and it leaves `WorkspacePolicies` in the same PR.

Guests see Chat only: the suite bar (`platform.md` §6.1 manifests) lists Chat for an account whose kind is `guest`,
and Mail's, Calendar's and Docs' routes answer 403 `guest` for it. Sharing a document with a guest is left out for
now: the Share dialog does not offer guests, and a grant that names one is refused. It comes later (ruling 8), when
Docs has a read-only view a guest can be given without the rest of the app.

### 6.6 Nothing else

Domains, DKIM, verify, primary, remove, kinds, policies, join link, emoji, avatar, agents and the bulk actions all
have their endpoints. The screen is mostly a client change.

## 7. Files

| Area | Files |
| --- | --- |
| web | `components/AdminView.tsx` becomes the shell (sections, hash routing); new `admin/General.tsx`, `admin/Members.tsx`, `admin/Domains.tsx` (from `DomainsSection.tsx`), `admin/Agents.tsx`; `Sidebar.tsx` menu; `modals.tsx` loses the appearance modal and the Invite dialog's two extras; `lib/api.ts` the new calls |
| shared | `dto.ts` (`name` in the patch body, `InviteDTO` list), `platform.ts` (`atProvider`, `hosted`) |
| edge | `routes/domains.ts` (nothing), `routes/accounts.ts` (provision one), `org/routes/index.ts` and `org/services/workspaces.ts` (name, invites list and revoke), `directory/core.ts` (`atProvider` in `describeDomains`, `hosted` in `listAccounts`) |
| docs | this file; `platform.md` §3.2 gets a pointer; `CHANGELOG.md` Parity line for native clients |

## 8. Phases

Each phase is one PR with its changelog entry; each ticks `web client` on the checklist and nothing else, since no
native client and nothing an agent observes changes.

1. **The shell and General.** Sections, hash deep links, the menu collapsed to two entries; General with everything
   in §3.1 (appearance, emoji, join link and Google self-registration moved in; `name` editable, the one API
   change). The Organization tab's member table moves to Members as it is; Domains and Automations move as they are.
   What people see: one "Workspace settings…" entry; the workspace can be renamed.
2. **Domains & mail.** The step cards (§4), **Turn on mail**, the platform card, the Mail summary; `atProvider`.
   What people see: an admin takes `example.com` to "mail ready" without leaving the screen.
3. **Members and provisioning.** The Mail column and filters, **Retry setup**, pending invitations with revoke,
   **Invite a chat guest** and the Chat-only suite bar for guests, the `defaultAccountKind` policy retired; `hosted`,
   §6.3, §6.4, §6.5. What people see: why a member has no mailbox, a button that fixes it, and a way to bring an
   outsider into Chat without giving them a mailbox.
4. **Agents & apps.** The section; the menu's Agents entry goes.
5. **e2e.** With the fake provider and a faked resolver (`deps.resolve`): add → verify → records present → turn on
   mail → DKIM present → primary → a new member's address lands on the domain. One run through the Members
   section: a stopped account, Retry, ready.

## 9. Open questions

1. **Per-organization retention.** `MAIL_RETENTION_DAYS` is global. A policy field `mailRetentionDays` with the
   global as default is small; is it wanted before anyone asks?
2. **Removing a domain at the provider.** `removeDomain` leaves the domain on MXRoute. The provider call exists
   (`deleteDomain`, refused while mailboxes exist); should Remove call it once no addresses remain?
3. **Transfer ownership to a non-member.** Today the heir must be a member and a person. Keep.

Answered 2026-11-09 (Scott; in `decision_log.md`): new joiners are native members, not a policy choice; a guest
invitation is a separate action limited to Chat; Google self-registration on any verified domain is later; document
sharing with guests is left out for now.

## 10. Rulings

Proposed, for `decision_log.md` once confirmed:

1. Workspace administration is one web screen, **Workspace settings…**, with sections; the workspace menu keeps
   that entry and **Automations** and loses the rest.
2. The slug never changes; the name may.
3. Turning mail on for an organization's own domain is an explicit admin step after the mail records are in DNS;
   the platform subdomain needs no step.
4. Changing the primary domain never moves an existing address.
5. Members who are not admins see Automations and nothing else of the screen.

Ruled by Scott on 2026-11-09 (recorded in `decision_log.md`):

6. Whoever joins a workspace, by invitation, join link or Google self-registration, is a native member. Inviting a
   guest is a separate action, and a guest uses Chat only. The `defaultAccountKind` policy is retired.
7. Google self-registration on any verified domain of the organization is later; for now the domain stays the
   admin's own Google login domain.
8. Guests cannot be given documents for now: the Share dialog does not offer them and Docs refuses them. Document
   sharing with guests is a later addition, noted here so it is not forgotten.
