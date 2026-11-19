# Worker startup time: heavy code loads on first use

- `[server]` exceljs, xlsx, imapflow, nodemailer, the Docs server, its MCP code and previews load on first use instead of at Worker start: local startup CPU about 390 → 220 ms. Cloudflare refuses a deploy whose startup takes over 1 s, and #872 was refused.
