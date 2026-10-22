import { useEffect, useMemo, useState } from 'react';
import { useChipIndex, useDevice } from './lib/useDevice';
import { decode, hex, lookup, parseValue } from './lib/decode';
import { RegisterSearch } from './components/RegisterSearch';
import { BitfieldStrip } from './components/BitfieldStrip';
import { FieldTable } from './components/FieldTable';
import { ExplainPanel } from './components/ExplainPanel';

// URL hash holds the whole state so a decode can be shared:
//   #stm32f407/GPIOA_MODER/0xABFFFFFF
interface Route {
  chip: string;
  reg: string;
  value: string;
}

const DEFAULT: Route = { chip: 'stm32f407', reg: 'GPIOA_MODER', value: '0xABFFFFFF' };

function readHash(): Route {
  const [chip, reg, value] = decodeURIComponent(location.hash.slice(1)).split('/');
  return chip ? { chip, reg: reg ?? '', value: value ?? '' } : DEFAULT;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('_');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

export default function App() {
  const { chips, error: indexError } = useChipIndex();
  const [route, setRoute] = useState<Route>(readHash);
  const [valueText, setValueText] = useState(route.value);
  const [hovered, setHovered] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);

  const chip = chips?.find((c) => c.id === route.chip) ?? chips?.[0];
  const { device, error: deviceError, loading } = useDevice(chip);

  // Keep the hash in sync; respond to back/forward.
  useEffect(() => {
    const h = `#${route.chip}/${route.reg}/${route.value}`;
    if (location.hash !== h) history.replaceState(null, '', h);
  }, [route]);
  useEffect(() => {
    const on = () => {
      const r = readHash();
      setRoute(r);
      setValueText(r.value);
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  // A register can name a peripheral containing "_" (e.g. OTG_FS_DEVICE), so
  // try every split point rather than just the first underscore.
  const hit = useMemo(() => {
    if (!device || !route.reg) return undefined;
    const parts = route.reg.split('_');
    for (let i = 1; i < parts.length; i++) {
      const h = lookup(device, parts.slice(0, i).join('_'), parts.slice(i).join('_'));
      if (h) return h;
    }
    const [p, r] = splitKey(route.reg);
    return lookup(device, p, r);
  }, [device, route.reg]);

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
    setRoute((r) => ({ ...r, value: h }));
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
  const error = indexError ?? deviceError;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect width="32" height="32" rx="6" fill="var(--accent)" />
            <g fill="#fff">
              <rect x="5" y="11" width="4" height="10" rx="1" />
              <rect x="11" y="11" width="4" height="10" rx="1" opacity=".55" />
              <rect x="17" y="11" width="4" height="10" rx="1" />
              <rect x="23" y="11" width="4" height="10" rx="1" opacity=".55" />
            </g>
          </svg>
          <div>
            <h1>RegLens</h1>
            <p className="tagline">Paste a register value from your debugger. See every bit, named from ST's own SVD.</p>
          </div>
        </div>
      </header>

      <section className="controls">
        <label className="ctl">
          <span>Chip</span>
          <select
            value={chip?.id ?? ''}
            disabled={!chips}
            onChange={(e) => setRoute((r) => ({ ...r, chip: e.target.value }))}
          >
            {chips?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ctl grow" htmlFor="reg">
          <span>Register</span>
          <RegisterSearch
            device={device}
            selectedKey={hit ? `${hit.peripheral.name}_${hit.register.name}` : route.reg}
            onSelect={(h) => setRoute((r) => ({ ...r, reg: h.key }))}
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
            onBlur={() => parsed.ok && setRoute((r) => ({ ...r, value: hex(parsed.value, size) }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && parsed.ok) setValue(parsed.value);
            }}
          />
        </label>
      </section>

      {error && <div className="notice error">Couldn't load register data: {error}</div>}
      {loading && <div className="notice">Loading {chip?.label} register map…</div>}
      {device && route.reg && !hit && (
        <div className="notice">
          No register called <span className="mono">{route.reg}</span> on {chip?.label}. Try searching above.
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

          <ExplainPanel chip={chip.id} registerKey={`${hit.peripheral.name}_${hit.register.name}`} valueHex={hex(decoded.value, size)} />
        </>
      )}

      <footer className="foot small dim">
        Register data: <a href="https://github.com/stm32-rs/stm32-rs">stm32-rs</a> patched SVDs, based on ST's CMSIS-SVD
        files. Decoding is deterministic; only the Explain panel uses AI. Not affiliated with STMicroelectronics.
      </footer>
    </div>
  );
}
