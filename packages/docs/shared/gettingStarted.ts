// The "Getting started" guide. The first time a user opens it from the home page a copy is made in their
// account (a real file they can present and edit); after that the tile opens that copy, found by its title
// (server/gettingStarted.ts). The copy is made from a presentation kept in the app; the slides here are the
// built-in one used where there is none (the desktop app, local development).
import { buildSlide, newId, type Deck, type LayoutId, type SlideContent } from './deck.ts';

export const GETTING_STARTED_TITLE = 'Getting started';

/** The built-in guide's slides, as the layouts build them. */
export const GETTING_STARTED_SLIDES: (SlideContent & { layout: LayoutId })[] = [
  { layout: 'title', title: 'Getting started with MCP Docs', subtitle: 'Documents, presentations and spreadsheets in one place' },
  { layout: 'title-body', title: 'Start something new', body: ['- Pick a blank spreadsheet, presentation or document from the home page', '- Or import a Word, PowerPoint, Excel, PDF, Markdown or CSV file', '- Everything saves automatically'] },
  { layout: 'title-body', title: 'Work with the assistant', body: ['- Open the Assistant to ask for edits in plain language', '- Select text or a slide element and ask about just that', '- Undo anything it changed in one step'] },
  { layout: 'section', title: 'More to come', subtitle: 'This guide is a placeholder and will grow.' },
];

/** A fresh copy of the guide. */
export function gettingStartedDeck(nextId: () => string = newId): Deck {
  return { version: 1, theme: 'light', slides: GETTING_STARTED_SLIDES.map(({ layout, ...content }) => buildSlide(layout, content, nextId)) };
}

/** The user's copy among their presentations, if they have one. */
export function findGettingStarted<T extends { title: string }>(decks: T[]): T | undefined {
  return decks.find((d) => d.title === GETTING_STARTED_TITLE);
}
