// The `flow-jobs` Queue's consumer (platform.md §5.2: the log is the source of truth, the Queue the retrying courier),
// which the Worker's default export hands each batch (index.ts).
import type { CheckAnswer, Events, JobMessage } from './object';

/**
 * Each message asks the job's Events object to check it: delivered again → retried after 120 s × attempts; still under
 * its lease → acked and sent again for when the lease ends (so a long turn does not use up the retries); otherwise
 * acked. A check that throws is retried; past max_retries the message goes to flow-jobs-dlq.
 */
export async function handleJobBatch(batch: MessageBatch<JobMessage>, env: { EVENTS: DurableObjectNamespace<Events>; JOBS?: Queue<JobMessage> }): Promise<void> {
  for (const m of batch.messages) {
    const { organizationId, jobId } = m.body ?? ({} as JobMessage);
    if (!organizationId || !jobId) {
      m.ack();
      continue;
    }
    try {
      const out = (await env.EVENTS.get(env.EVENTS.idFromName(organizationId)).checkJob(jobId)) as CheckAnswer;
      if ('retryAfter' in out) m.retry({ delaySeconds: out.retryAfter });
      else if ('requeueAfter' in out && env.JOBS) {
        await env.JOBS.send(m.body, { delaySeconds: Math.min(out.requeueAfter, 43_200) });
        m.ack();
      } else m.ack();
    } catch (err) {
      console.error(`[jobs] check of ${jobId}: ${(err as Error).message}`);
      m.retry();
    }
  }
}
