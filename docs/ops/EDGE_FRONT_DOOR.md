# The front door: the suite behind the Cloudflare Worker

Step 1 of `docs/specs/cloudflare-migration.md`. The Worker (`packages/edge`) goes in front of the AWS instance. It
serves the clients' built files and passes everything else to the instance, so nothing moves and nobody signs in
again. Afterwards a deploy of the server no longer shows visitors 502s on anything that can safely be repeated.

Plan an hour, most of it waiting. Step 3 restarts the instance, so both apps are down for a few minutes. The switch
itself (step 6) has no downtime and is undone in the Cloudflare dashboard in seconds.

## What stays on the origin, and why

- **Pages.** `/workspace` redirects a stranger to sign in and `/p/*` carries its own headers, so the origin keeps
  deciding per request until Docs is ported. The Worker holds no `.html` file.
- **Files over 25 MiB.** Workers Static Assets refuses them; today those are the assistant's two ONNX runtimes.
- **The other hosts.** On `docs.freeflow.im` and `mcpdocs.freeflow.im` every path goes to the origin: the plugin and
  the 301s to the app.

## Steps

1. **Make the secret and store it on both sides.** The value only has to match. Run this yourself so that it never
   appears in a log or a chat:
   ```sh
   SECRET=$(openssl rand -hex 32)
   aws ssm put-parameter --region us-west-2 --type SecureString --name /flow/EDGE_ORIGIN_SECRET --value "$SECRET"
   cd packages/edge && printf %s "$SECRET" | pnpm exec wrangler secret put EDGE_ORIGIN_SECRET
   ```
   `wrangler secret put` creates the Worker if it does not exist yet. A deploy (step 4) keeps the secret.

2. **Add the origin's DNS record.** In Cloudflare DNS for `freeflow.im`: `origin`, type A, the instance's Elastic IP
   (`44.236.200.216`), **DNS only (grey cloud)**. It must be grey: the Worker has to reach the instance directly.

3. **Update the stack** after the PR that added this page is merged and deployed. The procedure and checks are those
   of `FLOW_TO_AWS.md` step 2: the AMI pinned, the same parameters as now (`OriginDomainName` takes its default),
   only `Instance` (`UserData`) changing. The instance restarts. Then re-run the UserData through Systems Manager, as
   last time, and check that `/opt/mcpdocs/Caddyfile` has an `origin.freeflow.im` block.

   Then deploy the server once so that it starts with `FLOW_TRUST_PROXY=1`: `/opt/mcpdocs/deploy.sh flow <tag>`, or
   re-run the latest `flow-aws-deploy.yml`.

   Check it. The first should answer 403, which proves Caddy has the block and its certificate:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://origin.freeflow.im/
   node packages/edge/scripts/check-front-door.mjs app.freeflow.im
   ```

4. **Connect the deploys.** Create a Cloudflare API token with Workers Scripts: Edit, and Workers Routes: Edit, DNS: Edit
   and Zone: Read on `freeflow.im`. In the GitHub repository add the secret `CLOUDFLARE_EDGE_API_TOKEN`, check that
   `CLOUDFLARE_ACCOUNT_ID` is there (the home page's deploy uses it), and set the variable `EDGE_DEPLOY` to `true`.
   Run `deploy-edge.yml` by hand. This creates `edge.freeflow.im` and the routes. The routes take no traffic while
   the three records are grey.

5. **Rehearse on `edge.freeflow.im`.** Everything answers there exactly as it will on `app`, except browser sign-in.
   ```sh
   node packages/edge/scripts/check-front-door.mjs edge.freeflow.im   # expects "behind the Worker: yes"
   ```
   Before going further, in the Cloudflare dashboard for the zone, confirm these are off, as they alter or block what
   passes through: Bot Fight Mode (it can challenge the native apps, agents and ChatGPT's plugin calls), Rocket Loader,
   and any WAF rule that challenges rather than logs.

6. **Switch, one host at a time.** Turn the record's cloud orange, run the check, use the app for a few minutes:
   ```sh
   node packages/edge/scripts/check-front-door.mjs app.freeflow.im                # expects "behind the Worker: yes"
   node packages/edge/scripts/check-front-door.mjs docs.freeflow.im --legacy      # the same, after its record
   node packages/edge/scripts/check-front-door.mjs mcpdocs.freeflow.im --legacy   # the same, after its record
   ```
   Do `app` first, then check by hand: sign in, send a message from one window and see it arrive in another, open a
   document, upload a file, start the assistant, join a huddle. Then `docs`, and check ChatGPT's plugin. Then `mcpdocs`.

## Rollback

Turn the record's cloud back to grey. DNS answers change within a minute or so, and the instance answers directly as
before, with its own certificate.

## What to watch afterwards

- **Certificates for the three public names on the instance stop renewing** while their records are orange, because
  the challenge no longer reaches Caddy under those names. Nothing breaks, as visitors see Cloudflare's certificate.
  A rollback more than two months later makes Caddy fetch new ones, which takes a minute or so
  (`docker exec caddy caddy reload --config /etc/caddy/Caddyfile` if it is in back-off, as on the day of the AWS move).
- **Uploads over 100 MB through the server** are refused by Cloudflare below the Enterprise plan. The server's own
  body limit is also 100 MB, so nothing that worked before stops, and presigned uploads go directly to R2.
- **Rate limits now key on the visitor's address.** Until now every visitor shared Caddy's address and one bucket, so
  the limits were tighter in total than they looked. They loosen for a crowd and work properly against one abuser.

## After a week

Nothing here needs retiring yet: the origin stays until step 7 of the plan.
