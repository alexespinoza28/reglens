// The single-register decoder: register search, value, bitfield figure, field
// table and Explain. URL: #stm32f407/GPIOA_MODER/0xABFFFFFF

import { useMemo, useState } from 'react';
import { decode, hex, lookup, lookupKey, parseValue } from '../lib/decode';
import type { ChipIndexEntry, DeviceJson } from '../lib/types';
import { RegisterSearch } from './RegisterSearch';
import { BitfieldStrip } from './BitfieldStrip';
import { FieldTable } from './FieldTable';
import { ExplainPanel } from './ExplainPanel';

interface Props {
  device: DeviceJson | undefined;
  chip: ChipIndexEntry | undefined;
  reg: string;
  value: string;
  onChange: (r: { reg?: string; value?: string }) => void;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('_');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

export function DecodeView({ device, chip, reg, value: routeValue, onChange }: Props) {
  const [valueText, setValueText] = useState(routeValue);
  const [hovered, setHovered] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);

  const hit = useMemo(() => {
    if (!device || !reg) return undefined;
    return lookupKey(device, reg) ?? lookup(device, ...splitKey(reg));
  }, [device, reg]);

  const size = hit?.register.size ?? 32;
  const parsed = parseValue(valueText, size);
  const value = parsed.ok ? parsed.value : null;
  const decoded = useMemo(
    () => (device && hit && value !== null ? decode(device, hit.peripheral, hit.register, value) : undefined),
    [device, hit, value],
  );

  const setValue = (v: number) => {
    const h = hex(v, size);
    setValueText(h);
    onChange({ value: h });
  };

  const toggleBit = (bit: number) => {
    if (!decoded) return;
    const mask = 2 ** bit;
    const isSet = Math.floor(decoded.value / mask) % 2 === 1;
    setValue(isSet ? decoded.value - mask : decoded.value + mask);
  };

  const setField = (lsb: number, width: number, v: number) => {
    if (!decoded) return;
    const unit = 2 ** lsb;
    const old = Math.floor(decoded.value / unit) % 2 ** width;
    setValue(decoded.value + (v - old) * unit);
  };

  const changedCount = decoded?.fields.filter((f) => f.changedFromReset).length ?? 0;

  return (
    <>
      <section className="controls two">
        <label className="ctl grow" htmlFor="reg">
          <span>Register</span>
          <RegisterSearch
            device={device}
            selectedKey={hit ? `${hit.peripheral.name}_${hit.register.name}` : reg}
            onSelect={(h) => onChange({ reg: h.key })}
          />
        </label>
        <label className="ctl value">
          <span>Value</span>
          <input
            className={`mono ${parsed.ok || !valueText ? '' : 'bad'}`}
            value={valueText}
            spellCheck={false}
            placeholder="0xABFFFFFF or $1 = 0x..."
            onChange={(e) => setValueText(e.target.value)}
            onBlur={() => parsed.ok && onChange({ value: hex(parsed.value, size) })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && parsed.ok) setValue(parsed.value);
            }}
          />
        </label>
      </section>

      {device && reg && !hit && (
        <div className="notice">
          No register called <span className="mono">{reg}</span> on {chip?.label}. Try searching above.
        </div>
      )}
      {hit && !parsed.ok && valueText && <div className="notice error">{parsed.error}</div>}

      {decoded && device && chip && hit && (
        <>
          <section className="summary">
            <div>
              <div className="regname mono">
                {hit.peripheral.name}_{hit.register.name}
              </div>
              <div className="dim">{hit.register.description}</div>
            </div>
            <dl className="facts mono">
              <div>
                <dt>Address</dt>
                <dd>{hex(decoded.address)}</dd>
              </div>
              <div>
                <dt>Value</dt>
                <dd>{hex(decoded.value, size)}</dd>
              </div>
              {hit.register.reset !== undefined && (
                <div>
                  <dt>Reset</dt>
                  <dd>
                    <button className="link" onClick={() => setValue(hit.register.reset!)} title="Load the reset value">
                      {hex(hit.register.reset, size)}
                    </button>
                  </dd>
                </div>
              )}
              {hit.register.access && (
                <div>
                  <dt>Access</dt>
                  <dd>{hit.register.access}</dd>
                </div>
              )}
            </dl>
          </section>

          {decoded.reservedSet !== 0 && (
            <div className="notice warn">
              Reserved bits are set ({hex(decoded.reservedSet, size)}). Real hardware usually reads these as 0, so
              check that you copied the right register or value.
            </div>
          )}

          <BitfieldStrip decoded={decoded} hovered={hovered} onHover={setHovered} onToggleBit={toggleBit} />
          <p className="hint dim small">Click any bit to flip it. Fields that differ from reset are marked.</p>

          <div className="table-head">
            <h2>Fields</h2>
            <label className="small">
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only
              changed from reset ({changedCount})
            </label>
          </div>
          <FieldTable
            device={device}
            decoded={decoded}
            hovered={hovered}
            onHover={setHovered}
            onSetField={setField}
            onlyChanged={onlyChanged}
          />

          <ExplainPanel
            title="Explain this value"
            note="AI summary of the decoded fields only. It cannot add bits the SVD doesn't define."
            placeholder="Optional: what are you debugging? e.g. “PA5 LED won't toggle”"
            inputKey={`${chip.id}/${hit.peripheral.name}_${hit.register.name}/${hex(decoded.value, size)}`}
            body={(question) => ({
              chip: chip.id,
              register: `${hit.peripheral.name}_${hit.register.name}`,
              value: hex(decoded.value, size),
              question: question || undefined,
            })}
          />
        </>
      )}
    </>
  );
}
