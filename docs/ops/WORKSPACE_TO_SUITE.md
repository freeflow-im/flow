# The Workspace app into the suite: the cut-over runbook

Phase 2 of the FreeFlow suite (`docs/specs/freeflow-suite.md` §2.1–2.3, §8). The Workspace app (MCP Docs,
`packages/docs`) stops running in its own container (`app`, image `mcpdocs`) and is served by the suite's server
(`flow`, `packages/server/src/workspace.ts`) at `https://app.freeflow.im/workspace`, signed in with the suite's
accounts. Its data stays where it is (`/data/app` on the data volume, mounted into the suite's container at
`/data/workspace`); its accounts are imported into the suite's `users` once; its old host names
(`mcpdocs.freeflow.im`, `docs.freeflow.im`) send every page to the same page under `/workspace` and keep serving
the ChatGPT plugin (`/mcp`, `/oauth/*`) as before, so the plugin in ChatGPT's directory keeps working unchanged.

Everything runs on the instance from one script, `/opt/mcpdocs/workspace-to-suite.sh`, which the stack's UserData
writes. Plan 15 minutes; the Workspace app is unavailable for the few minutes the suite's container restarts, and
Chat for the same minutes. Do it on a different day from the Flow move (`docs/ops/FLOW_TO_AWS.md`).

## Before the day

1. **Merge the PR** that adds the Workspace app to the suite's image (the one that added this page) and let its
   deploy finish (`gh run list --repo freeflow-im/flow --workflow flow-aws-deploy.yml --limit 1`). Nothing
   changes yet: the suite serves the Workspace app only once the marker file of step 3 exists.
2. **Update the stack** with the same template (its UserData gained `caddyfile.sh`, `workspace-to-suite.sh` and
   the deploy script's Workspace part). The procedure and the checks are those of `FLOW_TO_AWS.md` step 2: pin the
   AMI, make the change set with the same parameters (`InstanceType`, `FlowDomainName`, `UseElasticIp` and the rest
   as they are now), expect only `Instance` (`UserData`) to change, execute it, and re-run the UserData on the
   instance from a Session Manager shell (`wc -c /root/user-data.sh` before `bash`). The instance restarts: both
   apps are down for a few minutes. Afterwards check `ls -l /opt/mcpdocs/`: `caddyfile.sh` and
   `workspace-to-suite.sh` are there, and both apps are back (`docker ps`).
3. **Rehearse the import** without changing anything: on the instance, with a copy of the docs database,
   ```sh
   mkdir -p /data/tmp/ws && cp /data/app/app.db /data/tmp/ws/ && chown -R 1000:1000 /data/tmp/ws
   docker run --rm --network mcpdocs -v /data/tmp/ws:/data/workspace --env-file /opt/mcpdocs/flow.env \
     $(docker inspect -f '{{.Config.Image}}' flow) node packages/server/scripts/import-workspace-users.ts /data/workspace
   rm -rf /data/tmp/ws
   ```
   It prints what it would do (`would create` an account for each Workspace user with the same id, `would merge`
   those whose email already has a suite account) and changes nothing without `--apply`.

## The switch

On the instance, as root:

```sh
/opt/mcpdocs/workspace-to-suite.sh
```

It stops and removes the docs app's container, writes the marker `/data/workspace-on-suite`, deploys the suite's
image again with the Workspace app on (`deploy.sh flow latest` now mounts `/data/app` at `/data/workspace`, sets
`WORKSPACE_DATA_DIR`, `WORKSPACE_PLUGIN_URL` and `WORKSPACE_LEGACY_HOSTS`, and copies the docs app's settings from
`/mcpdocs/` except its own sign-in and mail ones), imports the accounts (`import-workspace-users.ts --apply`, which
prints each one), and rewrites the Caddyfile so the old host names go to the suite. It is safe to run again.

Then:

- `curl -sI https://mcpdocs.freeflow.im/` is a 301 to `https://app.freeflow.im/workspace`; a file's old link
  (`https://mcpdocs.freeflow.im/s/<id>`) a 301 to the same path under `/workspace`.
- `https://app.freeflow.im/workspace` signed out sends to the suite's sign-in and back; signed in, the file list
  is the one from before, and a file opens and saves.
- `curl -s https://docs.freeflow.im/mcp` answers the plugin as before (a 401 or an MCP error, not a redirect), and
  in ChatGPT the Universal Docs plugin lists files after a sign-in through the suite (its OAuth page sends to
  `app.freeflow.im`).
- A Workspace user who had no suite account signs in to the suite with their Workspace password (the scrypt hash
  is accepted and replaced); one who had both signs in as before and sees their Workspace files.
- Download as PDF works (Chromium is in the image).
- The docs deploy workflow (`docs-aws-deploy.yml`) did nothing on the instance ("served by the suite now"); it was
  removed on 2026-11-03. Still to retire: the `mcpdocs` ECR repository and the `/mcpdocs/` parameters that the suite does not read
  (`GOOGLE_*`, `CLOUDFLARE_*`, `MAIL_FROM`, `PLUGIN_ENABLED`) in a follow-up once a week has passed.

## Rollback

```sh
/opt/mcpdocs/workspace-to-suite.sh undo
```

removes the marker, deploys the suite without the Workspace app, starts the docs app's container again on the
same data and routes the old host names back to it. The accounts imported into the suite stay (harmless); the docs
app's own sessions were never touched, so its users are signed in as before. Files saved through the suite in
between are in the same database, so nothing is lost either way.
