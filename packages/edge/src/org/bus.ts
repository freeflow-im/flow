// The event bus. On Node this was NATS; here the object is the bus: an event goes straight to the sockets of the object
// handling this request. The subject names stay, because they are what says who may receive an event (object.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Event } from '@flow/shared';

export type Publisher = (subject: string, event: Event) => void;
const current = new AsyncLocalStorage<Publisher>();
export const withPublisher = <T>(p: Publisher, fn: () => T): T => current.run(p, fn);

export function publishEvent(subject: string, event: Event): void {
  current.getStore()?.(subject, event);
}

export function subjectMsg(workspaceId: string, channelId: string): string {
  return (`ws.${workspaceId}.chan.${channelId}.msg`);
}
export function subjectTyping(workspaceId: string, channelId: string): string {
  return (`ws.${workspaceId}.chan.${channelId}.typing`);
}
export function subjectPresence(workspaceId: string): string {
  return (`ws.${workspaceId}.presence`);
}
export function subjectMeta(workspaceId: string): string {
  return (`ws.${workspaceId}.meta`);
}
export function subjectArtifact(workspaceId: string, channelId: string): string {
  return (`ws.${workspaceId}.chan.${channelId}.artifact`);
}
export function subjectIndicator(workspaceId: string, channelId: string): string {
  return (`ws.${workspaceId}.chan.${channelId}.indicator`);
}
export function subjectChannelEmoji(workspaceId: string, channelId: string): string {
  return (`ws.${workspaceId}.chan.${channelId}.emoji`);
}
export function subjectHuddle(workspaceId: string, channelId: string): string {
  return (`ws.${workspaceId}.chan.${channelId}.huddle`);
}
export function subjectHuddleAll(): string {
  return (`ws.*.chan.*.huddle`);
}
export function subjectWorkspaceAll(workspaceId: string): string {
  return (`ws.${workspaceId}.>`);
}
export function subjectPresenceSync(replicaId: string): string {
  return (`presence.sync.${replicaId}`);
}
export function subjectPresenceSyncAll(): string {
  return (`presence.sync.*`);
}
export function subjectUserMeta(userId: string): string {
  return (`user.${userId}.meta`);
}
export function subjectUserNotify(userId: string): string {
  return (`user.${userId}.notify`);
}
