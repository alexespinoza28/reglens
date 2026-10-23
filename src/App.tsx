import { useCallback, useEffect, useState } from 'react';
import { useChipIndex, useDevice } from './lib/useDevice';
import { DecodeView } from './components/DecodeView';
import { DoctorView } from './components/DoctorView';
import { WriteView } from './components/WriteView';

// The URL hash holds the whole state so any view can be shared:
//   #stm32f407/GPIOA_MODER/0xABFFFFFF        decode one register (original format)
//   #doctor/stm32f411/<base64url JSON>       peripheral doctor
//   #write/stm32f411/<base64url JSON>        write a config
type Mode = 'decode' | 'doctor' | 'write';

interface Route {
  mode: Mode;
  chip: string;
  reg: string;
  value: string;
  payload: string;
}

const DEFAULT: Route = { mode: 'decode', chip: 'stm32f407', reg: 'GPIOA_MODER', value: '0xABFFFFFF', payload: '' };

function readHash(): Route {
  const raw = location.hash.slice(1);
  const m = raw.match(/^(doctor|write)\/([a-z0-9]+)(?:\/([A-Za-z0-9_-]*))?$/);
  if (m) return { mode: m[1] as Mode, chip: m[2], reg: '', value: '', payload: m[3] ?? '' };
  if (raw === 'doctor' || raw === 'write') return { ...DEFAULT, mode: raw, chip: 'stm32f411', payload: '' };
  const [chip, reg, value] = decodeURIComponent(raw).split('/');
  return chip ? { mode: 'decode', chip, reg: reg ?? '', value: value ?? '', payload: '' } : DEFAULT;
}

function writeHash(r: Route): string {
  if (r.mode === 'decode') return `#${r.chip}/${r.reg}/${r.value}`;
  return `#${r.mode}/${r.chip}${r.payload ? `/${r.payload}` : ''}`;
}

const TABS: { mode: Mode; label: string }[] = [
  { mode: 'decode', label: 'Decode a register' },
  { mode: 'doctor', label: 'Peripheral doctor' },
  { mode: 'write', label: 'Write a config' },
];

export default function App() {
  const { chips, error: indexError } = useChipIndex();
  const [route, setRoute] = useState<Route>(readHash);
  // Bumped on back/forward so each view re-reads its inputs from the URL.
  const [epoch, setEpoch] = useState(0);

  const chip = chips?.find((c) => c.id === route.chip) ?? chips?.[0];
  const { device, error: deviceError, loading } = useDevice(chip);

  useEffect(() => {
    const h = writeHash(route);
    if (location.hash !== h) history.replaceState(null, '', h);
  }, [route]);
  useEffect(() => {
    const on = () => {
      setRoute(readHash());
      setEpoch((e) => e + 1);
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  const setPayload = useCallback((payload: string) => setRoute((r) => (r.payload === payload ? r : { ...r, payload })), []);
  const openRegister = useCallback((reg: string, value: string) => {
    setRoute((r) => ({ ...r, mode: 'decode', reg, value, payload: '' }));
    setEpoch((e) => e + 1);
    scrollTo({ top: 0 });
  }, []);
  const switchMode = (mode: Mode) => {
    if (mode === route.mode) return;
    setRoute((r) => ({
      ...r,
      mode,
      payload: '',
      reg: mode === 'decode' ? r.reg || DEFAULT.reg : r.reg,
      value: mode === 'decode' ? r.value || DEFAULT.value : r.value,
    }));
    setEpoch((e) => e + 1);
  };

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
            <p className="tagline">
              A peripheral doctor for STM32: paste registers from your debugger, see every bit named from the SVD, and
              find the setting that contradicts another.
            </p>
          </div>
        </div>
      </header>

      <nav className="modebar">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.mode}
              role="tab"
              aria-selected={route.mode === t.mode}
              className={`tab ${route.mode === t.mode ? 'active' : ''}`}
              onClick={() => switchMode(t.mode)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="ctl chip-ctl">
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
      </nav>

      {error && <div className="notice error">Couldn't load register data: {error}</div>}
      {loading && <div className="notice">Loading {chip?.label} register map…</div>}

      {route.mode === 'decode' && (
        <DecodeView
          key={`d${epoch}`}
          device={device}
          chip={chip}
          reg={route.reg}
          value={route.value}
          onChange={(p) => setRoute((r) => ({ ...r, ...p }))}
        />
      )}
      {route.mode === 'doctor' && (
        <DoctorView
          key={`o${epoch}`}
          device={device}
          chip={chip}
          payload={route.payload}
          onPayload={setPayload}
          onChip={(c) => setRoute((r) => ({ ...r, chip: c }))}
          onOpenRegister={openRegister}
        />
      )}
      {route.mode === 'write' && (
        <WriteView
          key={`w${epoch}`}
          device={device}
          chip={chip}
          payload={route.payload}
          onPayload={setPayload}
          onOpenRegister={openRegister}
        />
      )}

      <footer className="foot small dim">
        Register data: <a href="https://github.com/stm32-rs/stm32-rs">stm32-rs</a> patched SVDs, based on ST's CMSIS-SVD
        files. Decoding, the doctor's rules and the clock math are deterministic; only Explain and Write call an AI, and
        RegLens checks what it says. Not affiliated with STMicroelectronics. Always confirm critical settings against the
        reference manual.
      </footer>
    </div>
  );
}
