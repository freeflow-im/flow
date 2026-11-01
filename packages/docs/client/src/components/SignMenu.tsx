// The Sign menu of the PDF signer and the document editor: the user's saved signatures to pick from (each can be
// removed), and Add a signature… (SignatureDialog: drawn, typed or a picture, kept for next time or not).
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { SignatureDialog } from '../pdf/SignatureDialog.tsx';

/** A signature to sign with: one the user saved, or one made for this file only (`saved` false). */
export interface Signature {
  id: string;
  image: string;
  /** The picture's size in pixels, for its shape. */
  width: number;
  height: number;
  saved: boolean;
}

/** The size of a picture in pixels. */
export function pictureSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('The signature picture could not be read.'));
    img.src = src;
  });
}

/** Today, as a date is written on a form: Oct 19, 2026. */
export function today(): string {
  return new Date().toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** A signature's picture as a file, to store it with a document. */
export async function signatureFile(sig: Signature): Promise<Blob> {
  return (await fetch(sig.image)).blob();
}

let nextId = 0;

/** The user's signatures: the saved ones, read once, and any made for this file only. */
export function useSignatures() {
  const [signatures, setSignatures] = useState<Signature[]>([]);
  useEffect(() => {
    let stale = false;
    api.listSignatures().then(
      async ({ signatures: saved }) => {
        const sized = await Promise.all(
          saved.map(async (s) => ({
            id: s.id,
            image: s.image,
            saved: true,
            ...(await pictureSize(s.image)),
          })),
        );
        if (!stale) setSignatures((current) => [...sized, ...current.filter((c) => !c.saved)]);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, []);

  const add = async (image: string, remember: boolean): Promise<Signature> => {
    const size = await pictureSize(image);
    const sig: Signature = remember ? { ...(await api.addSignature(image)).signature, saved: true, ...size } : { id: `sig${++nextId}`, image, saved: false, ...size };
    setSignatures((ss) => [...ss, sig]);
    return sig;
  };

  /** Forget a signature (deleting a saved one); throws when the server refuses. */
  const forget = async (sig: Signature): Promise<void> => {
    if (sig.saved) await api.deleteSignature(sig.id);
    setSignatures((ss) => ss.filter((s) => s.id !== sig.id));
  };

  return { signatures, add, forget };
}

export type Signatures = ReturnType<typeof useSignatures>;

export function SignMenu({
  sigs,
  current,
  active,
  disabled,
  title,
  onPick,
  onForgot,
  onDate,
  onError,
}: {
  sigs: Signatures;
  /** The signature picked last, marked in the list. */
  current?: string | null;
  /** Show the button pressed (a signature is waiting to be placed). */
  active?: boolean;
  disabled?: boolean;
  title: string;
  onPick(sig: Signature): void;
  onForgot?(sig: Signature): void;
  /** Adds Today's date to the menu. */
  onDate?(): void;
  onError(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // The menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (sig: Signature) => {
    setOpen(false);
    onPick(sig);
  };

  const toggle = () => {
    // With nothing to pick from, the menu would only offer to make a signature.
    if (!sigs.signatures.length && !onDate) return setDialog(true);
    setOpen((o) => !o);
  };

  const forget = async (sig: Signature) => {
    try {
      await sigs.forget(sig);
      onForgot?.(sig);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async (image: string, remember: boolean) => {
    const sig = await sigs.add(image, remember);
    setDialog(false);
    onPick(sig);
  };

  return (
    <>
      {/* A click in the menu leaves the focus (and a document's selection) where it was. */}
      <span className="pdf-sign-menu" ref={ref} onMouseDown={(e) => e.preventDefault()}>
        <button className={`btn${active || open ? ' active' : ''}`} disabled={disabled} onClick={toggle} aria-haspopup="menu" aria-expanded={open} title={title}>
          Sign
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="pdf-sign-menu-list" role="menu">
            {sigs.signatures.map((sig) => (
              <div key={sig.id} className={`pdf-sign-menu-item${current === sig.id ? ' current' : ''}`}>
                <button role="menuitem" className="pdf-sign-menu-pick" onClick={() => pick(sig)} title={sig.saved ? 'Sign with this signature' : 'Sign with this signature (not saved, only for this file)'}>
                  <img src={sig.image} alt="A saved signature" />
                </button>
                <button className="pdf-sign-menu-remove" onClick={() => void forget(sig)} title={sig.saved ? 'Remove this saved signature' : 'Remove this signature'} aria-label="Remove this signature">
                  ×
                </button>
              </div>
            ))}
            <button
              role="menuitem"
              className="pdf-sign-menu-add"
              onClick={() => {
                setOpen(false);
                setDialog(true);
              }}
            >
              Add a signature…
            </button>
            {onDate && (
              <button
                role="menuitem"
                className="pdf-sign-menu-add"
                onClick={() => {
                  setOpen(false);
                  onDate();
                }}
              >
                Today's date
              </button>
            )}
          </div>
        )}
      </span>
      {dialog && <SignatureDialog onUse={add} onClose={() => setDialog(false)} />}
    </>
  );
}
