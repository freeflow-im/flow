// To, Cc and Bcc: addresses as chips. Typing a comma, semicolon, Enter or Tab (or leaving the field, or pasting a
// list) turns what was typed into chips; what is not an address stays as text, marked. Backspace in an empty field
// takes the last chip back into the text to edit. As the person types, `suggest` (the account's contacts) offers
// matches under the box: ↑/↓ move, Enter, Tab or a click take one, Esc dismisses them.
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { Address, Contact } from '../api';
import { formatAddress, parseAddressList, uniqueAddresses } from '../lib/addresses';
import { cn } from '../lib/utils';

export interface AddressFieldProps {
  label: string;
  value: Address[];
  onChange(next: Address[]): void;
  autoFocus?: boolean;
  /** Text typed but not yet a chip, so Send can include it (or refuse it). */
  onPendingChange?: (text: string) => void;
  /** The contacts matching what was typed (the account's, from the server). */
  suggest?: (q: string) => Promise<Contact[]>;
  trailing?: React.ReactNode;
}

/** How long typing pauses before the contacts are asked. */
export const SUGGEST_DELAY_MS = 120;

export function AddressField({ label, value, onChange, autoFocus, onPendingChange, suggest, trailing }: AddressFieldProps) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [active, setActive] = useState(0);
  const asked = useRef(0);

  const setPending = (t: string) => {
    setText(t);
    onPendingChange?.(t);
  };
  const clearSuggestions = () => {
    asked.current++;
    setSuggestions([]);
    setActive(0);
  };
  const commit = (raw: string) => {
    clearSuggestions();
    if (!raw.trim()) return setPending('');
    const { addresses, invalid: bad } = parseAddressList(raw);
    if (addresses.length) onChange(uniqueAddresses([...value, ...addresses]));
    setInvalid(bad.length > 0);
    setPending(bad.join(', '));
  };
  const pick = (c: Contact) => {
    clearSuggestions();
    onChange(uniqueAddresses([...value, { name: c.name, address: c.address }]));
    setInvalid(false);
    setPending('');
  };

  // The contacts matching the text, asked after a pause in typing; an answer to an older question is dropped.
  useEffect(() => {
    if (!suggest || !text.trim()) { setSuggestions([]); return; }
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      suggest(text.trim()).then((found) => {
        if (ask !== asked.current) return;
        const chosen = new Set(value.map((a) => a.address.toLowerCase()));
        setSuggestions(found.filter((c) => !chosen.has(c.address.toLowerCase())).slice(0, 8));
        setActive(0);
      }, () => { if (ask === asked.current) setSuggestions([]); });
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, suggest, value]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearSuggestions(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[active] ?? suggestions[0]!); return; }
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && text.trim())) {
      if (text.trim()) {
        e.preventDefault();
        commit(text);
      } else if (e.key === 'Enter') e.preventDefault();
    } else if (e.key === 'Backspace' && !text && value.length) {
      e.preventDefault();
      const last = value[value.length - 1]!;
      onChange(value.slice(0, -1));
      setPending(formatAddress(last));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (/[,;\n]/.test(pasted)) {
      e.preventDefault();
      commit(text + pasted);
    }
  };
  const listId = `${label.toLowerCase()}-suggestions`;

  return (
    <div className="relative flex min-h-[40px] items-center gap-2 border-b border-hairline px-1">
      <span className="w-10 shrink-0 text-[14px] text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1">
        {value.map((a, i) => (
          <span key={`${a.address}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-panel py-0.5 pr-1 pl-2.5 text-[14px]" title={a.address}>
            <span className="truncate">{a.name || a.address}</span>
            <button type="button" className="rounded-full p-0.5 text-muted hover:bg-row-selected hover:text-ink" aria-label={`Remove ${a.address}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-label={label}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            setInvalid(false);
            setPending(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(text)}
          aria-invalid={invalid}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          className={cn('h-7 min-w-[140px] flex-1 bg-transparent text-sm outline-none', invalid && 'text-danger')}
          type="text"
          // The browser's and password managers' autofill would put a saved address in the box as it opens (and the blur
          // would make it a chip); the field completes only from the account's contacts.
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-form-type="other"
          spellCheck={false}
        />
      </div>
      {trailing}
      {suggestions.length > 0 && (
        <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="absolute top-full left-12 z-20 mt-0.5 w-[min(420px,calc(100%-3rem))] overflow-hidden rounded-md border border-border bg-panel py-1 shadow-lg">
          {suggestions.map((c, i) => (
            <li
              key={c.address}
              role="option"
              aria-selected={i === active}
              className={cn('flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[14px]', i === active ? 'bg-row-selected' : 'hover:bg-hover')}
              // Picking with the mouse must not blur the box first (the blur would make the typed text a chip).
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
            >
              {c.name ? <span className="truncate text-ink">{c.name}</span> : null}
              <span className={cn('truncate', c.name ? 'text-muted' : 'text-ink')}>{c.address}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
