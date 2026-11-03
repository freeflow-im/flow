// Whether messages load their images from the web. Until the user chooses, they are hidden and the message says so;
// "Show images" there is the choice, made once for every message after it. Account settings can turn it off again.
import { browserPref } from './prefs';

export type ImagePref = 'ask' | 'always';
const pref = browserPref<ImagePref>('mail.remoteImages', ['ask', 'always']);
export const useImagePref = pref.use;
export const setImagePref = pref.set;
