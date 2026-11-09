// A request's body when a content-type parser made it a Buffer (app.ts addContentTypeParser), else null. One typed place to
// ask, so the narrowing holds wherever `Buffer` is declared loosely (the Worker's types make the global `any`).
export const rawBody = (req: { body: unknown }): Buffer | null => (Buffer.isBuffer(req.body) ? (req.body as Buffer) : null);
