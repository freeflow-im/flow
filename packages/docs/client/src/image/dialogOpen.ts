// The image editor shown over a document, presentation or spreadsheet takes the keyboard: a Backspace there
// deletes a layer of the picture, not what is selected in the page under it. Pages ask before handling a key.

export const IMAGE_DIALOG_CLASS = 'image-edit-dialog';

/** True while the image editor is open over the page. */
export const imageDialogOpen = (): boolean => typeof document !== 'undefined' && !!document.querySelector(`.${IMAGE_DIALOG_CLASS}`);
