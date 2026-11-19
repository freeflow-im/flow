# Worker startup time: heavy code loads on first use

- `[server]` exceljs, xlsx, imapflow, nodemailer, the Docs server, its MCP code and previews load on first use instead of at Worker start: local startup CPU about 390 → 220 ms. Cloudflare refuses a deploy whose startup takes over 1 s, and #872 was refused.
- `[server]` One Zod: edge, shared and the AWS server move from Zod 3 to Zod 4 (Docs was already on it), so the Worker bundles one copy.
