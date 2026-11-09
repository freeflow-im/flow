# The runtime seam

The Docs server reaches the machine it runs on through `#runtime/*` only (`docs/specs/docs-core.md` §3.1): files,
the database, HTTP, the request's context, PDFs, the browser, paths, and the standalone app's features under
`local/`. `package.json`'s `imports` map picks `node/` (this folder) by default and `workerd/` under the `workerd`
condition, which the Worker's bundler, its tests and its typecheck set. A core file that needs more of the machine
adds it here and in `workerd/`, in the same change.
