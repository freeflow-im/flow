/** A passing message at the bottom (App.tsx's toast): text, one with an action (Undo, Open), or one in progress ("Sending…"), which stays until the result replaces it. */
export type Notice = string | { text: string; progress?: true; action?: { label: string; run(): void } };
