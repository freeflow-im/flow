# The cut-over: the suite onto Cloudflare

The one switch of `docs/specs/cloudflare-migration.md` (ruled 2026-11-02: no users yet, so one cut-over). Before it,
`app.freeflow.im` goes through the Worker to AWS (`EDGE_FRONT_DOOR.md`). After it, the Worker answers the app itself:
accounts in the directory, each organization's Chat and Docs in its own objects, files in R2. AWS stays up, untouched,
until it is retired, and switching back is one setting.

Plan an afternoon: an hour to rehearse, an hour for the switch, and time to use the app between them.

## As run (2026-11-02 and 03)

- Rehearsed on edge.freeflow.im, then switched by #659 (`PORTED_HOSTS` gained app.freeflow.im) on 2026-11-03 00:34 UTC.
  The import ran once, before the switch; nobody used the old app in between, so it was not run again.
- Fixed during the rehearsal: R2's CORS rules lacked edge.freeflow.im (uploads), Docs Recents (#657), PDFs (#658).
- Fixed after the switch: the MCP Docs desktop app's Google sign-in (#660, desktop 0.2.38).
- Ported after the switch: the native apps' sign-in handoff and help pages (#661), link previews and PDF to Markdown for
  text PDFs (#663), pushes and huddles (#662; on once their settings are copied with `scripts/put-secrets.sh`).
- Not moved, by decision (decision_log 2026-11-03): the ChatGPT plugin stays on AWS, behind the Worker: `docs.freeflow.im`
  and `mcpdocs.freeflow.im`, with their `/mcp`, `/oauth/*` and `/.well-known/oauth-*`. So AWS is not retired yet ("After
  a week" below waits for the plugin).
- Added after the switch: Docs' own MCP endpoint on Cloudflare, `https://app.freeflow.im/mcp` (and `/mcp/v2`), with its
  OAuth on the same host (`/oauth/*`, `/.well-known/oauth-*`). Its sign-in is FreeFlow's session and its consent page
  chooses the organization; state in the directory object (`docs/specs/web-mcp.md`). Only the ported hosts serve it: the
  plugin's hosts above still reach AWS for those paths.
- The plugin's sign-in is the suite's, handed across hosts (2026-11-10): its `/oauth/sign-in` goes to
  `app.freeflow.im/api/auth/cross-host`, which returns a signed-in person to the plugin's `/oauth/handoff` with a one-time key
  that the AWS server redeems at `/api/auth/cross-host/exchange` with `EDGE_ORIGIN_SECRET` (the Worker's `PLUGIN_HOSTS` names
  the hosts allowed). Check after a deploy: in ChatGPT, connect Universal Docs as a new account; the sign-in lands on
  `app.freeflow.im`, comes back to `docs.freeflow.im`, and the consent page shows.

## What did not work on Cloudflare at the switch

OCR of scanned PDFs and resized link-preview pictures. Both were ported on 2026-11-03: OCR on a Cloudflare Container
(`packages/edge/containers/pdf-ocr`), pictures with the Images binding. What still runs on AWS is the ChatGPT plugin
above (`BUILD.md`).

## 1. Merge and deploy

Merge the pull request that added this page. The server and the Worker both deploy; nothing changes for the app yet.

## 2. The Worker's secrets

From `packages/edge`, logged in to AWS and to Cloudflare (`pnpm exec wrangler login`):
```sh
bash scripts/put-secrets.sh            # what it would set
bash scripts/put-secrets.sh --apply
```
Then the connectors' key, a file on the instance (Session Manager shell, as root):
```sh
docker exec flow cat /data/workspace/connector.key
```
and paste it into `pnpm exec wrangler secret put CONNECTOR_KEY_BASE64` on your machine.

## 3. Rehearse on edge.freeflow.im

On the instance, a dry run, then the import (it only reads Postgres and the Docs files):
```sh
docker exec -e EDGE_URL=https://edge.freeflow.im flow node packages/server/scripts/export-to-edge.ts
docker exec -e EDGE_URL=https://edge.freeflow.im flow node packages/server/scripts/export-to-edge.ts --apply
```
The dry run's first line lists the message keys. **If it warns of more than one, stop**: messages under the others
would not be readable, and that needs a decision first.

Then check it as a person would, from the instance (the sign-in link is mailed for real; request it with
`curl -X POST -H 'content-type: application/json' -d '{"email":"you@…"}' https://edge.freeflow.im/v1/auth/signin-link`
and take the token from the mail's link):
```sh
docker exec -e EDGE_URL=https://edge.freeflow.im -e CHECK_EMAIL=you@… -e SIGNIN_TOKEN=… flow node packages/server/scripts/check-edge-import.ts
```
And by hand, at https://edge.freeflow.im with an emailed sign-in link (Google sign-in is not set up for that host):
your organizations and channels, recent messages, sending one and seeing it arrive in a second window, a document, a
file, the assistant, a PDF.

## 4. Switch

1. **Freeze.** Nobody should change anything on the old app from here on: the import does not carry edits made after
   it. Run the import again (step 3's two commands), so it carries everything up to now. Rows already imported are
   kept as they are.
2. **Point the Worker at the app.** In `packages/edge/wrangler.toml`: `PORTED_HOSTS = "edge.freeflow.im,app.freeflow.im"`,
   `WEB_URL_BASE` and `FLOW_WEB_URL` to `https://app.freeflow.im`. Merge that; the deploy is the switch.
3. **Check:** `node packages/edge/scripts/check-front-door.mjs app.freeflow.im`, the check script against
   `https://app.freeflow.im`, and the app by hand, Google sign-in included.

## Rollback

Take `app.freeflow.im` out of `PORTED_HOSTS` and deploy: the app is AWS again, with its data as it was at the freeze.
Anything done on Cloudflare since is not on AWS.

## After a week (on hold while the plugin is on AWS)

Retire AWS (`FLOW_TO_AWS.md` has the stack): confirm first, because it deletes Postgres, the Docs files and the
instance. Keep a final `pg_dump` and a copy of `/data/app` in R2 before that.
