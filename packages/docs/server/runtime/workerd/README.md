# The runtime seam, on Workers

The `workerd` side of `#runtime/*` (see `../node/README.md`): files are R2 objects under the organization's prefix,
the database is the Docs object's own SQLite, HTTP is `DocsApp` (the part of Fastify the routes use), the context is
the object handling the request, PDFs are read by pdf.js with OCR in the PdfOcr container, the browser is Browser
Rendering, and the standalone app's features under `local/` are inert. Typechecked by `packages/edge` (its tsconfig
sets the `workerd` condition), not by this package.
