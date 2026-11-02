import { AccessToken } from 'livekit-server-sdk';

/** Long enough for the bridge's default one-hour call plus reconnect slack. */
export const AGENT_INFERENCE_TOKEN_TTL_SECONDS = 70 * 60;

/**
 * Mint the speech-only capability used by an authenticated agent bridge.
 * Keeping this separate from the room token makes it easy to prove that it
 * has no room, publish, subscribe, or administration grants.
 */
export async function mintAgentInferenceToken(
  apiKey: string,
  apiSecret: string,
  userId: string,
): Promise<string> {
  const inference = new AccessToken(apiKey, apiSecret, {
    identity: `flow-agent-${userId}`,
    ttl: AGENT_INFERENCE_TOKEN_TTL_SECONDS,
  });
  inference.addInferenceGrant({ perform: true });
  return inference.toJwt();
}
