# Flow to AWS: the runbook as it was run

- `[docs]` `docs/ops/FLOW_TO_AWS.md`: step 1 as a bash script with a dry run (the Railway CLI's `variables --kv` export; the redirect hosts, `VITE_*` and the R2 pair skipped), step 2's change set as it really reads (`Conditional` for an EBS instance is a restart; the Elastic IP; the parameters the old stack lacked), and a section on what differed on the day: shortened secrets in Railway's export, Caddy's certificate back-off, the sign-in link on the port forward.
