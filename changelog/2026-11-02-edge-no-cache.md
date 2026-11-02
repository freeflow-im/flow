# The Worker never stores the origin's answers

- `[server]` The Worker's requests to the origin bypass Cloudflare's cache, which otherwise stored anything whose path looked like a static file, under a key that ignores who is asking.
- `[server]` The Worker's files are copied out of the server's image rather than built again, so they have the names the server's pages ask for.
