// The open file's name in an editor's header, renamed by clicking into it: Enter or leaving it renames the file,
// Escape puts the name back.
import { useEffect, useState } from 'react';

export function TitleInput(props: {
  title: string;
  /** What the field is, for screen readers ("Document name"). */
  label: string;
  /** Rename the file; a refusal is reported by `onError` and the name put back. */
  onRename(title: string): Promise<unknown>;
  onError(message: string): void;
}) {
  const [title, setTitle] = useState(props.title);
  useEffect(() => setTitle(props.title), [props.title]);
  return (
    <input
      className="wb-title"
      value={title}
      aria-label={props.label}
      title="Rename"
      size={Math.max(8, title.length + 1)}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => {
        const t = title.trim();
        if (t && t !== props.title)
          props.onRename(t).catch((e: Error) => {
            setTitle(props.title);
            props.onError(e.message);
          });
        else setTitle(props.title);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setTitle(props.title);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}
