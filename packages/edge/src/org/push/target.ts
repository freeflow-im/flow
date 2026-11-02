// Which APNs door a push goes through: the topic it is sent under, and whether
// that is sandbox or production.
//
// Split out of ./index.ts so the real driver (./apnsSender.ts) can use these
// without importing the module that constructs it — the seam names the driver,
// the driver names the target, and nothing points back.
import { config } from '../config.js';
import type { ApnsHeaders, PushDevice } from './types.js';

/** The topic a push goes out under: the device's own registration wins. */
export function apnsTopicFor(device: PushDevice, opts?: ApnsHeaders): string {
  return opts?.topic ?? device.bundleId ?? config.apnsTopic;
}

/**
 * Sandbox or production: the per-device column wins over the global default.
 *
 * This is the TestFlight trap in one line. A TestFlight build talks to
 * PRODUCTION APNs while a locally signed development build talks to sandbox,
 * and both can be registered against one server at the same time — so the
 * environment has to be a property of the token, not of the deployment.
 * `FLOW_APNS_ENV` is only the fallback for a row that somehow carries none.
 */
export function apnsEnvFor(device: PushDevice): 'sandbox' | 'production' {
  return device.environment ?? config.apnsEnv;
}
