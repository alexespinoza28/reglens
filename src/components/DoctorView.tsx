// The peripheral doctor: paste a dump, get cross-register findings, computed
// baud/PWM numbers, the clock tree and every decoded register.

import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_HSE, formatMHz, type Clock } from '../lib/clocks';
import { citeText, cite } from '../lib/cite';
import { hex } from '../lib/decode';
import { RULES, diagnose, type DoctorOptions } from '../lib/doctor';
import { mapDump, parseDump } from '../lib/dump';
import { DOCTOR_EXAMPLES } from '../lib/examples';
import { decodePayload, encodePayload } from '../lib/share';
import type { ChipIndexEntry, DeviceJson } from '../lib/types';
import { ExplainPanel } from './ExplainPanel';
import { FindingCard, QuantityCard } from './Findings';

export interface DoctorState {
  t: string; // dump text
  q: string; // question
  h: string; // HSE MHz
  a1: string; // APB1 MHz
  a2: string;
  t1: string; // APB1 timer MHz
  t2: string;
  b: string; // target baud
}

const EMPTY: DoctorState = { t: '', q: '', h: '', a1: '', a2: '', t1: '', t2: '', b: '' };

interface Props {
  device: DeviceJson | undefined;
  chip: ChipIndexEntry | undefined;
  payload: string;
  onPayload: (payload: string) => void;
  onChip: (chip: string) => void;
  onOpenRegister: (key: string, value: string) => void;
}

const mhz = (s: string) => {
  const n = Number(s);
  return s.trim() && Number.isFinite(n) && n > 0 ? n * 1e6 : undefined;
};

export function DoctorView({ device, chip, payload, onPayload, onChip, onOpenRegister }: Props) {
  const [st, setSt] = useState<DoctorState>(() => ({ ...EMPTY, ...decodePayload<DoctorState>(payload) }));
  const set = (patch: Partial<DoctorState>) => setSt((s) => ({ ...s, ...patch }));

  useEffect(() => {
    onPayload(st.t || st.q ? encodePayload(st) : '');
    // onPayload is a stable setter from App; re-run only when inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const chipId = chip?.id ?? '';
  const hseDefault = DEFAULT_HSE[chipId];
  const opts: DoctorOptions = useMemo(
    () => ({
      question: st.q,
      hseHz: mhz(st.h) ?? hseDefault,
      apb1Hz: mhz(st.a1),
      apb2Hz: mhz(st.a2),
      tim1Hz: mhz(st.t1),
      tim2Hz: mhz(st.t2),
      targetBaud: Number(st.b) > 0 ? Number(st.b) : undefined,
    }),
    [st, hseDefault],
  );

  const parsed = useMemo(() => parseDump(st.t), [st.t]);
  const mapped = useMemo(() => (device ? mapDump(device, parsed) : undefined), [device, parsed]);
  const dx = useMemo(() => (device && mapped && mapped.registers.length ? diagnose(device, mapped, opts) : undefined), [device, mapped, opts]);

  const examples = DOCTOR_EXAMPLES;
  const peripherals = mapped ? [...new Set(mapped.registers.map((r) => r.peripheral.name))] : [];

  const clockRow = (label: string, c: Clock) => (
    <tr key={label}>
      <td>{label}</td>
      <td className="mono num">{c.hz !== undefined ? formatMHz(c.hz) : '—'}</td>
      <td className="dim small">{c.source === 'manual' ? 'typed in' : c.source === 'rcc' ? 'from RCC' : 'unknown'}</td>
    </tr>
  );

  return (
    <>
      <section className="doctor-input">
        <label className="ctl">
          <span>Register dump</span>
          <textarea
            className="mono"
            rows={10}
            spellCheck={false}
            value={st.t}
            placeholder={`Paste what GDB or OpenOCD printed, for example:\n(gdb) x/10wx 0x40020000\n0x40020000:\t0xa80000a0\t0x00000000\t0x0c0000f0\t0x64000040\n...\nAlso: GPIOA->MODER = 0x...,  p/x *USART2,  0x40004408 = 0x8b`}
            onChange={(e) => set({ t: e.target.value })}
          />
        </label>
        <div className="examples">
          <span className="dim small">Examples:</span>
          {examples.map((ex) => (
            <button
              key={ex.id}
              className="chip-btn"
              onClick={() => {
                if (chipId !== ex.chip) onChip(ex.chip);
                setSt({ ...EMPTY, t: ex.dump, q: ex.question });
              }}
            >
              {ex.label}
            </button>
          ))}
        </div>
        <label className="ctl">
          <span>What's wrong? (optional)</span>
          <input
            value={st.q}
            maxLength={200}
            placeholder="e.g. PC13 LED never lights, or USART2 prints garbage at 115200"
            onChange={(e) => set({ q: e.target.value })}
          />
        </label>
        <fieldset className="clock-inputs">
          <legend className="small dim">Clocks in MHz (blank = derive from RCC in the dump)</legend>
          {(
            [
              ['h', 'HSE crystal', hseDefault ? String(hseDefault / 1e6) : ''],
              ['a1', 'APB1', 'from RCC'],
              ['a2', 'APB2', 'from RCC'],
              ['t1', 'APB1 timers', 'from RCC'],
              ['t2', 'APB2 timers', 'from RCC'],
              ['b', 'Target baud', 'from question'],
            ] as const
          ).map(([k, label, ph]) => (
            <label key={k} className="ctl small-ctl">
              <span>{label}</span>
              <input className="mono" inputMode="decimal" value={st[k]} placeholder={ph} onChange={(e) => set({ [k]: e.target.value })} />
            </label>
          ))}
        </fieldset>
      </section>

      {!st.t.trim() && (
        <div className="notice">
          Paste a dump above, or press an example. RegLens reads GDB <span className="mono">x/Nwx</span>, OpenOCD{' '}
          <span className="mono">mdw</span>, <span className="mono">p/x *PERIPH</span> and{' '}
          <span className="mono">NAME = value</span> lines, maps every word to its register by address, and checks the
          registers against each other.
        </div>
      )}

      {mapped && st.t.trim() && (
        <p className="dim small status-line">
          Read {mapped.wordCount} word{mapped.wordCount === 1 ? '' : 's'} → {mapped.registers.length} register
          {mapped.registers.length === 1 ? '' : 's'} on {peripherals.length} peripheral{peripherals.length === 1 ? '' : 's'}
          {peripherals.length ? ` (${peripherals.join(', ')})` : ''}.
          {mapped.unmapped.length > 0 && ` ${mapped.unmapped.length} non-zero word${mapped.unmapped.length > 1 ? 's' : ''} at addresses with no register.`}
          {mapped.notes.map((n) => ` ${n}`)}
        </p>
      )}
      {mapped && mapped.skipped.length > 0 && st.t.trim() && (
        <details className="skipped small">
          <summary>
            {mapped.skipped.length} line{mapped.skipped.length > 1 ? 's' : ''} skipped
          </summary>
          <ul>
            {mapped.skipped.map((s, i) => (
              <li key={i}>
                <span className="mono">line {s.line}: {s.text.slice(0, 80)}</span> <span className="dim">({s.reason})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {mapped && st.t.trim() && !mapped.registers.length && (
        <div className="notice error">No registers recognised on {device?.name}. Check the chip menu and the pasted text.</div>
      )}

      {dx && device && chip && mapped && (
        <>
          <section className="doctor-section">
            <div className="section-head">
              <h2>Findings</h2>
              <span className="dim small">Deterministic rules over the decoded fields. No AI.</span>
            </div>
            {dx.findings.length === 0 ? (
              <div className="notice">
                No cross-register problems found by RegLens's rules. Checked: {RULES.map((r) => r.title.toLowerCase()).join('; ')}.
              </div>
            ) : (
              <div className="findings">
                {dx.findings.map((f, i) => (
                  <FindingCard key={i} f={f} />
                ))}
              </div>
            )}
            {dx.hints.length > 0 && (
              <ul className="hints small">
                {dx.hints.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            )}
          </section>

          {dx.quantities.length > 0 && (
            <section className="doctor-section">
              <div className="section-head">
                <h2>Computed</h2>
                <span className="dim small">Reference-manual formulas with the values above.</span>
              </div>
              <div className="quantities">
                {dx.quantities.map((q, i) => (
                  <QuantityCard key={i} q={q} />
                ))}
              </div>
            </section>
          )}

          <section className="doctor-section">
            <div className="section-head">
              <h2>Clocks</h2>
            </div>
            <div className="clock-grid">
              <div className="table-wrap">
                <table className="fields clocks">
                  <tbody>
                    {clockRow('SYSCLK', dx.clocks.sysclk)}
                    {clockRow('HCLK (AHB)', dx.clocks.hclk)}
                    {clockRow('PCLK1 (APB1)', dx.clocks.pclk1)}
                    {clockRow('PCLK2 (APB2)', dx.clocks.pclk2)}
                    {clockRow('APB1 timers', dx.clocks.tim1)}
                    {clockRow('APB2 timers', dx.clocks.tim2)}
                  </tbody>
                </table>
              </div>
              <div className="small">
                {dx.clocks.steps.length > 0 && (
                  <ol className="steps mono">
                    {dx.clocks.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                )}
                {dx.clocks.notes.map((n, i) => (
                  <p key={i} className="dim">
                    {n}
                  </p>
                ))}
              </div>
            </div>
          </section>

          <section className="doctor-section">
            <div className="section-head">
              <h2>Registers</h2>
              <span className="dim small">Fields that differ from reset. Open any register in the decoder.</span>
            </div>
            <div className="table-wrap">
              <table className="fields regs">
                <thead>
                  <tr>
                    <th>Register</th>
                    <th className="num">Value</th>
                    <th>Changed from reset</th>
                  </tr>
                </thead>
                <tbody>
                  {mapped.registers.map((r) => {
                    const changed = r.decoded.fields.filter((f) => f.changedFromReset);
                    return (
                      <tr key={r.key}>
                        <td className="mono">
                          <button className="link" onClick={() => onOpenRegister(r.key, hex(r.value, r.register.size))}>
                            {r.key}
                          </button>
                          <div className="dim small">{hex(r.address)}</div>
                        </td>
                        <td className="mono num">{hex(r.value, r.register.size)}</td>
                        <td className="small mono">
                          {changed.length === 0 ? <span className="dim">at reset</span> : changed.map((f) => citeText(cite(r, f.field.name)!).replace(`${r.key}.`, '')).join(' · ')}
                          {r.decoded.reservedSet !== 0 && <div className="warn-text">reserved bits set: {hex(r.decoded.reservedSet, r.register.size)}</div>}
                          {r.upperBits !== undefined && <div className="warn-text">upper 16 bits of the word were non-zero</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <ExplainPanel
            title="Explain findings"
            note="AI summary of the findings and numbers above. Every field value and number in it is checked against the decoder."
            question={st.q}
            inputKey={`${chip.id}/${encodePayload(st)}`}
            body={(question) => ({
              chip: chip.id,
              dump: st.t,
              question: question || undefined,
              hseHz: opts.hseHz,
              apb1Hz: opts.apb1Hz,
              apb2Hz: opts.apb2Hz,
              tim1Hz: opts.tim1Hz,
              tim2Hz: opts.tim2Hz,
              targetBaud: opts.targetBaud,
            })}
          />
        </>
      )}
    </>
  );
}
