// To, Cc and Bcc: addresses as chips. Typing a comma, semicolon, Enter or Tab (or leaving the field, or pasting a
// list) turns what was typed into chips; what is not an address stays as text, marked. Backspace in an empty field
// takes the last chip back into the text to edit.
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { Address } from '../api';
import { formatAddress, parseAddressList, uniqueAddresses } from '../lib/addresses';
import { cn } from '../lib/utils';

export interface AddressFieldProps {
  label: string;
  value: Address[];
  onChange(next: Address[]): void;
  autoFocus?: boolean;
  /** Text typed but not yet a chip, so Send can include it (or refuse it). */
  onPendingChange?: (text: string) => void;
  trailing?: React.ReactNode;
}

export function AddressField({ label, value, onChange, autoFocus, onPendingChange, trailing }: AddressFieldProps) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);

  const setPending = (t: string) => {
    setText(t);
    onPendingChange?.(t);
  };
  const commit = (raw: string) => {
    if (!raw.trim()) return setPending('');
    const { addresses, invalid: bad } = parseAddressList(raw);
    if (addresses.length) onChange(uniqueAddresses([...value, ...addresses]));
    setInvalid(bad.length > 0);
    setPending(bad.join(', '));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && text.trim())) && !e.nativeEvent.isComposing) {
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

  return (
    <div className="flex min-h-[40px] items-center gap-2 border-b border-hairline px-1">
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
          className={cn('h-7 min-w-[140px] flex-1 bg-transparent text-sm outline-none', invalid && 'text-danger')}
          type="text"
          autoComplete="email"
          spellCheck={false}
        />
      </div>
      {trailing}
    </div>
  );
}
