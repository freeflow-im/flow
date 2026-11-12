// The clients the assembler copies into public/, from the apps' manifests (@flow/shared's APP_MANIFESTS): each one's
// build folder, where it goes under public/, the page it files under public/_pages (and any second entry's), and whether a
// deploy may lack it.
// Shared with the edge's tests (src/manifests.test.ts), which check the list against the manifests.
import path from 'node:path';

/**
 * @param {import('@flow/shared').AppManifest[]} manifests
 * @param {string} root the repository's root, which `client.dist` is relative to
 * @param {string} out public/
 */
export function clientsFrom(manifests, root, out) {
  return manifests
    .filter((m) => m.client)
    .map((m) => ({
      name: m.name,
      from: path.join(root, m.client.dist),
      to: path.join(out, m.client.basePath),
      page: m.pages?.find((p) => !p.file)?.html ?? null,
      // A second entry's page (Calendar's book.html): its built file, filed under _pages by its own name.
      extra: (m.pages ?? []).filter((p) => p.file).map((p) => ({ file: p.file, page: p.html })),
      optional: !!m.client.optional,
    }));
}
