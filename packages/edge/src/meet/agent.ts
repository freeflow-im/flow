// An agent in a Meet meeting (docs/specs/meetings.md §5.4, phase 5): one object per agent sent to a meeting, holding
// RealtimeKit's Agent Participant WebSocket so the agent is in the room (it shows in People, and RTK counts it). It
// hears nothing: RTK agents get no audio or video, and live transcription is off (ruling 2026-11-23); the agent works in
// the meeting's chat and from the transcript afterwards (org/services/meetingAgents.ts).
//
// A connected agent keeps RTK's session going and is billed, so the object leaves as soon as no person is left: on a
// participant leaving, and on an alarm every 20 s (which also sends RTK's ping), and at the latest after MAX_STAY_MS.
// When it leaves it tells the organization's object, which marks the agent gone.
import { DurableObject } from 'cloudflare:workers';
import type { Org } from '../org/object';

export interface MeetingAgentEnv {
  ORG: DurableObjectNamespace<Org>;
  RTK_ACCOUNT_ID?: string;
  RTK_APP_ID?: string;
  RTK_API_TOKEN?: string;
}

/** What the organization's object hands over when an agent is sent (Org.sendMeetingAgent). */
export interface MeetingAgentStart {
  organizationId: string;
  /** The `meeting_agents` row. */
  meetingAgentId: string;
  rtkMeetingId: string;
  /** The agent's RTK participant token. */
  token: string;
}

const WS_URL = 'https://api.realtime.cloudflare.com/agent-ws/v1?subscriptions=participant';
/** RTK asks for a ping every 20 s. */
const TICK_MS = 20_000;
/** The longest an agent stays, whatever happens. */
export const MAX_STAY_MS = 4 * 60 * 60 * 1000;
/** A custom participant id that is an agent's, not a person's (org/services/meetingAgents.ts). */
export const AGENT_ID_PREFIX = 'agent:';

interface Stay extends MeetingAgentStart {
  until: number;
}

interface RtkParticipant {
  custom_participant_id?: string;
  left_at?: string | null;
}

/** Whether a room still has a person in it, by RTK's own list of who is in its running session. */
export async function peopleIn(env: MeetingAgentEnv, rtkMeetingId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.RTK_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}`;
  const get = async <T>(path: string): Promise<T | null> => {
    const res = await fetcher(`${base}${path}`, { headers: { Authorization: `Bearer ${env.RTK_API_TOKEN}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`realtimekit ${path}: ${res.status}`);
    return ((await res.json()) as { data?: T }).data ?? null;
  };
  const session = await get<{ id: string }>(`/meetings/${rtkMeetingId}/active-session`);
  if (!session) return false;
  const list = await get<RtkParticipant[] | { participants?: RtkParticipant[] }>(`/sessions/${session.id}/participants`);
  const rows = Array.isArray(list) ? list : (list?.participants ?? []);
  return rows.some((p) => !p.left_at && !(p.custom_participant_id ?? '').startsWith(AGENT_ID_PREFIX));
}

export class MeetingAgent extends DurableObject<MeetingAgentEnv> {
  private ws: WebSocket | null = null;
  private requests = 0;

  /** Join the room as the agent (the organization's object has made the RTK participant). */
  async start(p: MeetingAgentStart): Promise<void> {
    const stay: Stay = { ...p, until: Date.now() + MAX_STAY_MS };
    await this.ctx.storage.put('stay', stay);
    await this.openSocket(stay);
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /** Sent away by someone in the room. */
  async stop(): Promise<void> {
    await this.leave('sent away');
  }

  private async openSocket(stay: Stay): Promise<void> {
    const res = await fetch(WS_URL, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${stay.token}`, 'Sec-WebSocket-Protocol': 'realtimekit.v1' },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error(`the meeting service refused the agent (${res.status})`);
    ws.accept();
    ws.addEventListener('message', (e) => void this.onMessage(e.data));
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
    });
    this.ws = ws;
    this.send('connection.get', {});
  }

  private send(name: string, data: unknown): void {
    this.ws?.send(JSON.stringify({ category: 'request', request_id: `${name}-${++this.requests}`, name, data }));
  }

  private async onMessage(raw: unknown): Promise<void> {
    let msg: { category?: string; name?: string };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (msg.name === 'session.ended') return this.leave('the meeting ended');
    if (msg.name === 'participant.leave') await this.leaveIfAlone();
  }

  private async leaveIfAlone(): Promise<void> {
    const stay = await this.ctx.storage.get<Stay>('stay');
    if (!stay) return;
    try {
      if (!(await peopleIn(this.env, stay.rtkMeetingId))) await this.leave('everyone left');
    } catch (err) {
      console.warn(`[meet-agent] could not ask who is in: ${(err as Error).message}`);
    }
  }

  /** Every 20 s while it stays: RTK's ping, the check that people are still there, and a reconnect if the socket went. */
  override async alarm(): Promise<void> {
    const stay = await this.ctx.storage.get<Stay>('stay');
    if (!stay) return;
    if (Date.now() > stay.until) return this.leave('it stayed as long as it may');
    await this.leaveIfAlone();
    if (!(await this.ctx.storage.get<Stay>('stay'))) return;
    try {
      if (!this.ws) await this.openSocket(stay);
      else this.send('connection.ping', {});
    } catch (err) {
      return this.leave(`it could not stay connected: ${(err as Error).message}`);
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  private async leave(why: string): Promise<void> {
    const stay = await this.ctx.storage.get<Stay>('stay');
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'agent_stopped');
    } catch {
      // Already closed.
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    if (!stay) return;
    console.log(`[meet-agent] ${stay.meetingAgentId} left: ${why}`);
    await this.env.ORG.get(this.env.ORG.idFromName(stay.organizationId))
      .meetingAgentLeft(stay.meetingAgentId)
      .catch((err: Error) => console.error(`[meet-agent] could not tell the organization: ${err.message}`));
  }
}
