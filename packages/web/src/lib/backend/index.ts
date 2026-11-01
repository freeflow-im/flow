// One WorkspaceBackend per ConnectionRuntime. Components reach it through
// `useBackend()` and gate controls with `useCapability()`; they never construct
// a server path themselves.
import { useMemo, useSyncExternalStore } from 'react';
import type { Capabilities, Capability, CapabilityName, WorkspaceBackend } from '@flow/shared';
import type { ConnectionRuntime } from '../connectionRuntime';
import { useRuntime } from '../../state';
import { FlowBackend } from './flowBackend';

const backends = new WeakMap<ConnectionRuntime, WorkspaceBackend>();

export function backendFor(runtime: ConnectionRuntime): WorkspaceBackend {
  let backend = backends.get(runtime);
  if (backend) return backend;
  backend = new FlowBackend(runtime);
  backends.set(runtime, backend);
  return backend;
}

/** The backend for the connection this subtree is mounted on. */
export function useBackend(): WorkspaceBackend {
  const runtime = useRuntime();
  return useMemo(() => backendFor(runtime), [runtime]);
}

/** Live capability map: re-renders when the backend learns its grant changed. */
export function useCapabilities(): Capabilities {
  const backend = useBackend();
  // The third argument serves static renders (tests use renderToStaticMarkup),
  // which have no subscription phase.
  return useSyncExternalStore(
    (onChange) => backend.subscribe((event) => { if (event.type === 'capabilities.changed') onChange(); }),
    () => backend.capabilities(),
    () => backend.capabilities(),
  );
}

export function useCapability(name: CapabilityName): Capability {
  return useCapabilities()[name];
}

export { FlowBackend };
