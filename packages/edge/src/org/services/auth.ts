// The little of identity the organization's services use. Sign-in itself is the directory's.
import type { UserDTO } from '@flow/shared';
import { hashPassword, verifyPassword } from '../../directory/passwords';
import { schema } from '../db/index';

export const hashSecret = async (secret: string) => hashPassword(secret);
export const verifySecret = (hash: string, secret: string) => verifyPassword(hash, secret);
export function visibleEmail(u: { id: string; email: string; privacyMode: boolean }, viewerId?: string): string {
  return u.privacyMode && u.id !== viewerId ? '' : u.email;
}
export function toUserDTO(u: typeof schema.users.$inferSelect, viewerId?: string): UserDTO {
  return {
    id: u.id, email: visibleEmail(u, viewerId), privacyMode: u.privacyMode, displayName: u.displayName, avatarUrl: u.avatarUrl,
    timezone: u.timezone, statusEmoji: u.statusEmoji, statusText: u.statusText, website: u.website, bio: u.bio, title: u.title,
    isAgent: u.isAgent, sponsorId: u.isAgent ? u.sponsorUserId : null, notificationPrefs: u.notificationPrefs,
    statusSuppressAlerts: u.statusSuppressAlerts, createdAt: u.createdAt.toISOString(),
  } as UserDTO;
}
