// Stands in for the runtime's module under vitest, which runs in Node. Objects are exercised through their cores, or,
// for the little an object adds (events/object.test.ts), with a stand-in state.
export class DurableObject {
  constructor(protected readonly ctx?: unknown, protected readonly env?: unknown) {}
}
// @cloudflare/containers' ContainerProxy extends it (src/pdfOcr.ts).
export class WorkerEntrypoint {}
