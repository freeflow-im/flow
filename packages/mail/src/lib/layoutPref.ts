// Where an opened message shows: 'full', as Gmail does, in place of the list (with a way back to it), or 'split',
// beside the list. Narrow screens always show it in place of the list.
import { browserPref } from './prefs';

export type ReadingPane = 'full' | 'split';
const pref = browserPref<ReadingPane>('mail.readingPane', ['full', 'split']);
export const useReadingPane = pref.use;
export const setReadingPane = pref.set;
