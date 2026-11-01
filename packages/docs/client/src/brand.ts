// The app's name as this page shows it (shared/brand.ts): set once the server says whether it is the
// desktop app (AuthProvider), so code outside React (the assistant's tools) can name it too.
import { appName as nameFor, HOSTED_NAME } from '../../shared/brand.ts';

let name = HOSTED_NAME;

export const appName = (): string => name;

export function setLocalApp(local: boolean): void {
  name = nameFor(local);
  // index.html names the hosted app; a page that sets no title of its own (Settings) shows this one's.
  if (document.title === HOSTED_NAME) document.title = name;
}
