// The built-in "Meeting notes" automation (Taskboard task 32; decision_log 2026-11-22, "Agents remember through the event
// log"). It replaces Meet phase 5's headless Notes turn: an agent sent to a meeting is woken by its own `meet.ended`
// (org/services/meetingAgents.ts) and writes the notes, saves them for whoever sent it, and records in its memory that it
// was there, also when there is no transcript. It is an ordinary wake automation, made the first time the agent is sent
// (Org.ensureNotesAutomation), owned by the agent's sponsor (else the person who first sent it), who sees it in
// Automations and can change its instruction or delete it; once deleted it is not made again.
import type { NewSubscription } from '../events/core';

/** The automation's name, as people see it in Automations. */
export const MEETING_NOTES_NAME = 'Meeting notes';

/** What the agent is told to do (wakeBrief puts the event above it). */
export const MEETING_NOTES_PROMPT = [
  'A meeting you were sent to has ended: the meet.ended event above (meetingId, sessionId, title, who sent you, who was there, and what became of the transcript).',
  '1. If transcript is "saved": read it with read_meeting_transcript, then write the meeting notes in Markdown: a short summary, the decisions made, the action items (who does what, by when if said) and the open questions. Leave out a section with nothing in it, and use only what is in the transcript. Save them with save_meeting_notes: they go to the My files of the person who sent you. Then show_alert them ("Meeting notes ready", with the link).',
  '2. In every case, also with no transcript: write a short entry in your memory, a file under /memories/meetings/ (under /memories/you/meetings/ if you have a /memories/you/ folder) named by the date and title. Say that you attended, when, who sent you, who was there, the key points if there were any, and the notes\' link if you saved them.',
  'Post nothing anywhere else. Answer with one line saying what you did.',
].join('\n');

/**
 * The subscription: the owner's automation, worked by the agent (the consumer), on the agent's own `meet.ended` events,
 * which are addressed to it (`consumerOwn`; events/object.ts reads them as the agent for its own wake automations).
 */
export function meetingNotesSubscription(p: { organizationId: string; agentAccountId: string; ownerAccountId: string }): NewSubscription {
  return {
    name: MEETING_NOTES_NAME,
    consumer: p.agentAccountId,
    owner: p.ownerAccountId,
    createdBy: p.ownerAccountId,
    delivery: 'wake',
    filter: { types: ['meet.ended'], consumerOwn: true },
    action: { kind: 'wake', prompt: MEETING_NOTES_PROMPT },
    organizationId: p.organizationId,
  };
}
