/** An error the API reports as `{ error: { code, message } }`, the shape the clients already read. */
export class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
export const unauthorized = (msg = 'invalid or expired token') => new ApiError(401, 'unauthorized', msg);
export const notFound = (msg = 'not found') => new ApiError(404, 'not_found', msg);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const badRequest = (code: string, msg: string) => new ApiError(400, code, msg);
