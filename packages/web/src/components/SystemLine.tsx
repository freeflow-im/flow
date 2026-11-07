import type { MessageDTO } from '@flow/shared';
import { referencesIn, useReferenceLookup } from '../lib/references';
import { ReferenceChip } from './ReferenceChip';

const URL_RE = /https?:\/\/\S+/g;

/** A URL as a same-origin href: its path, query and hash, so it opens here, in this tab. Null when it is not a URL. */
function sameOriginHref(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/** A channel event line (join/leave, a share notice) — centered, muted, no
 * avatar/header. The body is the pre-rendered sentence ("Alice joined the
 * channel"). In a share notice (`file_shared`, platform phase 3.3) the address
 * on its own line is the shared object's chip (platform phase 6.4), resolved for
 * the reader by the message list; outside one (or for an address on another
 * server) a link. Everything else is plain. */
export function SystemLine({ message }: { message: MessageDTO }) {
  const lookup = useReferenceLookup();
  const found = message.systemKind === 'file_shared' && lookup?.organizationId ? referencesIn(message.body, lookup.origin, lookup.organizationId, 1)[0] : undefined;
  if (found && lookup) {
    const sentence = message.body.slice(0, message.body.indexOf(found.url)).trim();
    return (
      <div data-testid={`system-message-${message.id}`} className="flex flex-col items-center py-1 text-center">
        <span className="text-[11px] text-faint">{sentence}</span>
        <ReferenceChip found={found} resolved={lookup.get(found.ref)} />
      </div>
    );
  }
  const body = message.body;
  const parts: React.ReactNode[] = [];
  if (message.systemKind === 'file_shared') {
    let at = 0;
    for (const m of body.matchAll(URL_RE)) {
      const href = sameOriginHref(m[0]);
      if (!href) continue;
      parts.push(body.slice(at, m.index));
      parts.push(<a key={m.index} href={href} className="underline hover:text-ink">{m[0]}</a>);
      at = m.index + m[0].length;
    }
    parts.push(body.slice(at));
  } else parts.push(body);
  return (
    <div data-testid={`system-message-${message.id}`} className="whitespace-pre-line py-1 text-center">
      <span className="text-[11px] text-faint">{parts}</span>
    </div>
  );
}
