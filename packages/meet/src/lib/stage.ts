// What the meeting room's stage shows (components/Room.tsx). With nothing pinned and no screen shared, everyone shares an
// even grid. Otherwise one view fills the stage and every other view is a small square in the strip below it. That view
// is the pinned one, or else the shared screen. Pinning is this viewer's own choice and nobody else sees it.

/** A view on the stage: a person's camera tile, or the screen someone is sharing. */
export type View = { kind: 'person'; id: string } | { kind: 'screen'; id: string };

/** What the viewer pinned: a person's tile or a shared screen, by the sharer's id. */
export type Pin = View | null;

export type StageLayout = { kind: 'grid'; people: string[] } | { kind: 'focus'; main: View; strip: View[] };

export const sameView = (a: Pin, b: Pin): boolean => !!a && !!b && a.kind === b.kind && a.id === b.id;

/**
 * Lays out the stage for the people in the room (in order), the person sharing their screen (if anyone is), and what
 * the viewer pinned. A pin whose person left or whose screen is no longer shared is ignored, so the stage goes back to
 * the grid (or to the shared screen) without the viewer unpinning.
 */
export function stageLayout(people: readonly string[], presenter: string | null, pin: Pin): StageLayout {
  const live = (v: Pin): v is View => !!v && (v.kind === 'person' ? people.includes(v.id) : v.id === presenter && people.includes(v.id));
  const screen: View | null = presenter && people.includes(presenter) ? { kind: 'screen', id: presenter } : null;
  const main = live(pin) ? pin : screen;
  if (!main) return { kind: 'grid', people: [...people] };
  const views: View[] = [...(screen ? [screen] : []), ...people.map((id): View => ({ kind: 'person', id }))];
  return { kind: 'focus', main, strip: views.filter((v) => !sameView(v, main)) };
}

/**
 * The pin to keep after people come and go. A pin on someone whose connection was replaced by a newer one of their own
 * (lib/rejoin.ts: old id → new id) follows them to the new one. A pin on someone who left is dropped, so they are not
 * pinned again if the same connection somehow comes back later. A pinned screen is dropped once it is no longer shared.
 */
export function keepPin(pin: Pin, people: readonly string[], presenter: string | null, replaced: ReadonlyMap<string, string>): Pin {
  if (!pin) return null;
  const id = replaced.get(pin.id) ?? pin.id;
  if (!people.includes(id)) return null;
  if (pin.kind === 'screen' && id !== presenter) return null;
  return id === pin.id ? pin : { ...pin, id };
}
