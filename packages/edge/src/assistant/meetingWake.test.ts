// An agent's built-in "Meeting notes" automation (assistant/meetingWake.ts): its sponsor's wake subscription on the
// agent's own `meet.ended` events (org/services/meetingAgents.ts). It wakes the agent for its own meetings only, for a
// personal agent and for a shared one alike, and the job's brief carries the event, transcript and all.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Events, type JobMessage } from '../events/object';
import type { PublishInput } from '../events/core';
import { MEETING_WAKE_NAME, MEETING_WAKE_PROMPT, meetingWakeSubscription } from './meetingWake';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const ORG = 'org-1';
const ANN = 'acct-ann', BEN = 'acct-ben', ADA = 'acct-ada', OMNI = 'acct-omni';

/** Ann sponsors Ada (personal) and Omni (shared); Ben sponsors nobody. */
function harness() {
  const sent: JobMessage[] = [];
  const sponsored = (id: string) => (id === ANN ? [ADA, OMNI] : []);
  const org = {
    privateChannelIdsOfAccounts: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, []])), agentAccountIds: async () => [ADA, OMNI], pokeSubscription: async () => 0,
    personalAgentAccountsOf: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === ANN ? [ADA] : []])),
    sponsoredAgentAccountsOf: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, sponsored(id)])),
  };
  const env = { ORG: { idFromName: (n: string) => n, get: () => org }, JOBS: { send: async (body: JobMessage) => { sent.push(body); } } };
  const storage = { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined };
  return { o: new Events({ storage, waitUntil: () => undefined } as never, env as never), sent };
}

const ended = (agent: string, title: string): PublishInput => ({
  type: 'meet.ended', organizationId: ORG, actor: null, audience: `account:${agent}`, about: [agent], ts: new Date().toISOString(),
  data: { meetingId: 'm1', sessionId: 's1', title, transcript: { docId: 'doc-1', url: 'https://app.test/docs/md/doc-1', hadSpeech: true, speakers: ['Ann'] } },
});

describe('the Meeting notes automation (assistant/meetingWake.ts)', () => {
  it("is the sponsor's automation, worked by the agent, on the agent's own meet.ended", async () => {
    const { o } = harness();
    const sub = await o.createSubscription(meetingWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: ANN }));
    expect(sub).toMatchObject({ name: MEETING_WAKE_NAME, consumer: ADA, owner: ANN, delivery: 'wake', filter: { types: ['meet.ended'], consumerOwn: true }, action: { kind: 'wake', prompt: MEETING_WAKE_PROMPT } });
    expect(o.listSubscriptions(ANN).map((s) => s.id)).toEqual([sub.id]);
  });

  it('wakes a personal agent and a shared one for their own meetings, and not for each other\'s', async () => {
    const { o, sent } = harness();
    const ada = await o.createSubscription(meetingWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: ANN }));
    const omni = await o.createSubscription(meetingWakeSubscription({ organizationId: ORG, agentAccountId: OMNI, sponsorAccountId: ANN }));
    await o.publish(ended(ADA, 'Weekly sync'));
    await o.publish(ended(OMNI, 'Board'));
    await o.settled();
    const adaJobs = o.listJobs(ada.id), omniJobs = o.listJobs(omni.id);
    expect(adaJobs.map((j) => j.agent)).toEqual([ADA]);
    expect(omniJobs.map((j) => j.agent)).toEqual([OMNI]);
    expect(sent).toHaveLength(2);
    // The brief names the event and carries its data: the agent finds the transcript's doc id there.
    const brief = o.jobBrief(adaJobs[0]!.id, ADA)!;
    expect(brief).toContain(MEETING_WAKE_PROMPT.split('\n')[0]!);
    expect(brief).toContain('Weekly sync');
    expect(brief).toContain('doc-1');
    expect(brief).not.toContain('Board');
  });

  it('a person who sponsors neither agent gets no job from an automation they own on them', async () => {
    const { o } = harness();
    // Not a path the server takes (it always names the sponsor), but the log's rule holds: Ben may not act on Ada's events.
    const sub = await o.createSubscription(meetingWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: BEN }));
    await o.publish(ended(ADA, 'Weekly sync'));
    await o.settled();
    expect(o.listJobs(sub.id)).toEqual([]);
  });
});
