import { useEffect, useId, useRef, useState } from 'react';
import type { Pick } from './types';

interface Props {
  label: string;
  value: Pick | null;
  onChange: (value: Pick | null) => void;
  search: (q: string) => Promise<Pick[]>;
  /** When given, typing a name that is not in the list offers to add it. */
  create?: (label: string) => Promise<Pick>;
  createLabel?: string;
  placeholder?: string;
  disabled?: boolean;
}

/** A search box that picks one existing record, or adds a new one by name. */
export function Combobox({ label, value, onChange, search, create, createLabel = 'Add', placeholder, disabled }: Props) {
  const id = useId();
  const [text, setText] = useState('');
  const [items, setItems] = useState<Pick[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!open) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      search(text)
        .then((r) => {
          setItems(r);
          setFailed(false);
          setActive(0);
        })
        .catch(() => setFailed(true));
    }, 180);
    return () => clearTimeout(timer.current);
  }, [text, open, search]);

  const exact = items.some((i) => i.label.toLowerCase() === text.trim().toLowerCase());
  const canCreate = Boolean(create) && text.trim().length > 0 && !exact;
  const total = items.length + (canCreate ? 1 : 0);

  const choose = async (index: number): Promise<void> => {
    const item = items[index];
    if (item) {
      onChange(item);
    } else if (canCreate && create) {
      setBusy(true);
      try {
        onChange(await create(text.trim()));
      } catch {
        setFailed(true);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setText('');
    setOpen(false);
  };

  if (value) {
    return (
      <div className="field">
        <span className="legend">{label}</span>
        <div className="combo-picked">
          <span>{value.label}</span>
          {!disabled && (
            <button type="button" className="link-btn" onClick={() => onChange(null)} aria-label={`Remove ${label.toLowerCase()}`}>
              Change
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="field combo">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled || busy}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, Math.max(total - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open && total > 0) {
            e.preventDefault();
            void choose(active);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && (total > 0 || failed) && (
        <ul className="combo-list" role="listbox" id={`${id}-list`}>
          {items.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === active} onMouseDown={() => void choose(i)}>
              {it.label}
              {it.hint && <small>{it.hint}</small>}
            </li>
          ))}
          {canCreate && (
            <li role="option" aria-selected={active === items.length} onMouseDown={() => void choose(items.length)}>
              {createLabel} “{text.trim()}”
            </li>
          )}
          {failed && <li aria-disabled="true">Could not load the list. Try again.</li>}
        </ul>
      )}
    </div>
  );
}
