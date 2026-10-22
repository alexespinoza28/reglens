import { useMemo, useRef, useState } from 'react';
import type { DeviceJson } from '../lib/types';
import { buildIndex, search, type RegisterHit } from '../lib/search';
import { hex } from '../lib/decode';

interface Props {
  device: DeviceJson | undefined;
  selectedKey: string | undefined;
  onSelect: (hit: RegisterHit) => void;
}

export function RegisterSearch({ device, selectedKey, onSelect }: Props) {
  const index = useMemo(() => (device ? buildIndex(device) : []), [device]);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = query ?? selectedKey ?? '';
  const hits = useMemo(() => (query ? search(index, query) : []), [index, query]);

  const choose = (h: RegisterHit) => {
    onSelect(h);
    setQuery(null);
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="search">
      <input
        ref={inputRef}
        id="reg"
        className="mono"
        placeholder={device ? 'GPIOA_MODER, rcc->ahb1enr, 0x40020000' : 'Loading registers…'}
        disabled={!device}
        autoComplete="off"
        spellCheck={false}
        value={shown}
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls="reg-results"
        onFocus={(e) => {
          e.currentTarget.select();
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            setActive((a) => Math.min(a + 1, hits.length - 1));
            e.preventDefault();
          } else if (e.key === 'ArrowUp') {
            setActive((a) => Math.max(a - 1, 0));
            e.preventDefault();
          } else if (e.key === 'Enter' && hits[active]) {
            choose(hits[active]);
            e.preventDefault();
          } else if (e.key === 'Escape') {
            setQuery(null);
            setOpen(false);
          }
        }}
      />
      {open && query && (
        <ul id="reg-results" className="results" role="listbox">
          {hits.length === 0 && <li className="empty">No register matches “{query}”.</li>}
          {hits.map((h, i) => (
            <li
              key={h.key}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(h);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="mono strong">{h.key}</span>
              <span className="mono dim">{hex(h.address)}</span>
              <span className="desc">{h.register.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
