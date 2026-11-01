// A presentation or document that is a PowerPoint or Word file (desktop app): the chip by its name, and the
// questions its editor asks. A file made elsewhere that holds things the app cannot keep (`notKept`) is
// read-only until the user allows editing it; a change the file cannot hold asks to keep it in the app's own
// format instead. The page wires `onRefused` to its controller and sets the store's guard.
import { useState, type ReactNode } from 'react';
import { EDIT_NOT_ALLOWED } from '../state/store.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { ConfirmModal } from './Modal.tsx';
import { appName } from '../brand.ts';

/** The program each Office format belongs to. */
const PROGRAM: Record<string, string> = { xlsx: 'Excel', pptx: 'PowerPoint', docx: 'Word' };

type Question = { kind: 'allow'; retry?: () => void } | { kind: 'own'; reason: string; retry?: () => void } | null;

export function useOfficeFile(opts: {
  meta: SheetMeta;
  /** What saving would remove, from the load; cleared once the user allows editing. */
  initialNotKept?: string[];
  /** The app's own kind of file, e.g. "presentation". */
  own: string;
  /** The user allowed editing: set the guard of the file's format. */
  allow(): void;
  /** Keep the file in the app's own format instead; resolves once it is. */
  keepOwn(): Promise<void>;
  notify(text: string): void;
}): { locked: boolean; onRefused: (reason: string, retry: () => void) => void; chip: ReactNode; dialogs: ReactNode } {
  const [notKept, setNotKept] = useState(opts.initialNotKept);
  const [question, setQuestion] = useState<Question>(null);
  const program = opts.meta.format ? PROGRAM[opts.meta.format] : undefined;
  if (!program) return { locked: false, onRefused: () => {}, chip: null, dialogs: null };

  const onRefused = (reason: string, retry: () => void) => setQuestion(reason === EDIT_NOT_ALLOWED ? { kind: 'allow', retry } : { kind: 'own', reason, retry });
  const chip = notKept ? (
    <button className="format-chip locked" title={`This ${program} file has things ${appName()} can't keep (${notKept.join('; ')}). Click to allow editing.`} onClick={() => setQuestion({ kind: 'allow' })}>
      {program} · Read-only
    </button>
  ) : (
    <span className="format-chip" title={`This is a ${program} file: edits are saved to it as a ${program} file.`}>
      {program}
    </span>
  );
  const dialogs = (
    <>
      {question?.kind === 'allow' && (
        <ConfirmModal
          title={`Edit this ${program} file?`}
          message={
            <>
              “{opts.meta.title}” has things {appName()} can't keep:
              {/* One per line: labels ("Cell borders") and the import's sentences ("Charts were dropped.") alike. */}
              {(notKept ?? []).map((n) => (
                <span key={n} className="modal-list-item">
                  {n}
                </span>
              ))}
              If you edit it, they are removed from the file when it saves. A copy of the file as it is now is kept in the app's trash folder.
            </>
          }
          confirmText="Edit anyway"
          onConfirm={() => {
            opts.allow();
            setNotKept(undefined);
            question.retry?.();
          }}
          onClose={() => setQuestion(null)}
        />
      )}
      {question?.kind === 'own' && (
        <ConfirmModal
          title={`Keep as a ${appName()} ${opts.own}?`}
          message={
            <>
              {question.reason} cannot be saved in a {program} file. Keeping “{opts.meta.title}” as a {appName()} {opts.own} instead lets it hold them. It will no
              longer be a {program} file, and you can still download it as {program}.
            </>
          }
          confirmText={`Keep as ${opts.own}`}
          onConfirm={async () => {
            await opts.keepOwn();
            question.retry?.();
            opts.notify(`Kept as a ${appName()} ${opts.own}.`);
          }}
          onClose={() => setQuestion(null)}
        />
      )}
    </>
  );
  return { locked: !!notKept, onRefused, chip, dialogs };
}
