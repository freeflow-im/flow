// Pushes. Not sent yet: APNs over HTTP/2 from a Queue consumer comes with the native apps' move.
export type { ApnsHeaders, ApnsPayload, PushDevice } from './types';
export const pushSender = () => null;
export async function sendPush(..._args: unknown[]): Promise<{ ok: boolean; reason: string; retryable: boolean; disableDevice: boolean }> { return { ok: true, reason: '', retryable: false, disableDevice: false }; }
