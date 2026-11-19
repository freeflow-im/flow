# Worker startup: Assistant agent code on first use, and a CI check

- `[server]` The Assistant object loads the Docs agent, its tool schemas and the Anthropic SDK on first use: local startup CPU about 115 → 77 ms.
- `[qa]` CI job `edge-startup` measures the Worker's startup CPU on every PR and fails above a limit, before Cloudflare refuses the deploy.
