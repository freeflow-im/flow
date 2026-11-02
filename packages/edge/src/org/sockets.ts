// What the routes ask of the sockets. The object provides it for the current request.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SocketControl { disconnectUser(userId: string): void }
export const socketControl = new AsyncLocalStorage<SocketControl>();
export const disconnectUser = (userId: string) => socketControl.getStore()?.disconnectUser(userId);
export const detachUserFromWorkspace = (userId: string, _workspaceId: string) => disconnectUser(userId);
