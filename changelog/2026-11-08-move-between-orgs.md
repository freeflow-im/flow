# Operator route: move one person's Docs and assistant chats between organizations

- `[server]` `POST /v1/admin/accounts/move` (edge secret): copies a member's Docs files, folders, favorites and R2 bodies, and their assistant chats, from one organization to another, `INSERT OR IGNORE` so it reruns as a no-op; `prune: true` then deletes from the source only what the target is found to have.
- `[server]` Moved files land private in My files: grants to the source organization, its people and channels are dropped (and reported); link grants are kept, and on prune the directory points file ids and link tokens at the target.
- `[qa]` `packages/edge/test/e2e-move.mjs` (copy, rerun, prune, links, share index, chats); rewrite rules unit-tested in `src/docs/move.test.ts`.
