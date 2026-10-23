// The peripheral doctor: deterministic cross-register rules and computed
// quantities over a mapped dump. No AI here; the Explain function summarizes
// what this file found, and verifyDoctorReply() checks that summary.

import { AF_TABLES, isOutputSignal, type AfRow } from './afmap.js';
import { cite, citeText, type Cite } from './cite.js';
import { clockFor, deriveClocks, enableBit, family, formatMHz, type ClockOverrides, type Clocks, type Family } from './clocks.js';
import { hex, lookupKey } from './decode.js';
import { DumpView, type MappedDump } from './dump.js';
import type { DeviceJson } from './types.js';

export type Severity = 'error' | 'warn' | 'info';
export type RuleId = 'clock-off' | 'pin-mux' | 'output-as-input' | 'not-enabled' | 'baud-error';

export const RULES: { id: RuleId; title: string }[] = [
  { id: 'clock-off', title: 'Peripheral clock enabled in RCC' },
  { id: 'pin-mux', title: 'Pins routed to the peripheral (alternate function)' },
  { id: 'output-as-input', title: 'Output pins not left in input mode' },
  { id: 'not-enabled', title: 'Peripheral, channel and timer outputs enabled' },
  { id: 'baud-error', title: 'Baud rate within 2% of the target' },
];

export interface Finding {
  rule: RuleId;
  severity: Severity;
  title: string;
  detail: string;
  cites: Cite[];
}

export interface Quantity {
  kind: 'baud' | 'pwm' | 'update';
  peripheral: string;
  channel?: number;
  title: string;
  /** Headline, e.g. "359,712 baud" or "1 kHz, 25% duty". Absent when an input is missing. */
  display?: string;
  /** Formula steps with the numbers substituted. */
  lines: string[];
  cites: Cite[];
  /** What to add when the quantity can't be computed. */
  needs?: string;
  numbers: { baud?: number; target?: number; errorPct?: number; impliedHz?: number; freqHz?: number; dutyPct?: number; clockHz?: number };
}

export interface DoctorOptions extends ClockOverrides {
  question?: string;
  targetBaud?: number;
}

export interface Diagnosis {
  family: Family;
  clocks: Clocks;
  findings: Finding[];
  quantities: Quantity[];
  hints: string[];
  /** Peripherals the pin and enable checks focused on. */
  targets: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
const STANDARD_BAUDS = [1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];
const TARGET_KIND = /^(USART|UART|LPUART|TIM|SPI|I2C)\d+$/;
const OUTPUT_WORDS = /\b(led|output|blink|blinks|toggle|toggles|drive|drives|light|lights|lit|relay|buzzer)\b/i;

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
export function fmtHz(hz: number): string {
  if (hz >= 1e6) return `${+(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${+(hz / 1e3).toFixed(3)} kHz`;
  return `${+hz.toFixed(3)} Hz`;
}
const fmtPct = (p: number, signed = false) => `${signed && p > 0 ? '+' : ''}${+p.toFixed(p !== 0 && Math.abs(p) < 1 ? 2 : 1)}%`;

function regAddress(device: DeviceJson, key: string): string {
  const h = lookupKey(device, key);
  return h ? hex(h.peripheral.base + h.register.offset) : '';
}
const dumpCmd = (device: DeviceJson, key: string) => `${key} (x/1wx ${regAddress(device, key)})`;

// --- GPIO helpers --------------------------------------------------------

type PinMode = 'input' | 'output' | 'af' | 'analog';
interface PinState {
  mode: PinMode;
  cites: Cite[];
  /** F103 only: CNF bits (0/1 = push-pull/open-drain or analog/floating; 2/3 = AF or pull). */
  cnf?: number;
}

function pinState(view: DumpView, fam: Family, port: string, n: number): PinState | undefined {
  if (fam === 'f1') {
    const r = view.reg(`${port}_CR${n < 8 ? 'L' : 'H'}`);
    if (!r) return undefined;
    const mode = cite(r, `MODE${n}`)!;
    const cnf = cite(r, `CNF${n}`)!;
    let m: PinMode;
    if (mode.value === 0) m = cnf.value === 0 ? 'analog' : 'input';
    else m = cnf.value >= 2 ? 'af' : 'output';
    return { mode: m, cites: [mode, cnf], cnf: cnf.value };
  }
  const r = view.reg(`${port}_MODER`);
  const c = r && cite(r, `MODER${n}`);
  if (!c) return undefined;
  return { mode: (['input', 'output', 'af', 'analog'] as const)[c.value], cites: [c] };
}

function afState(view: DumpView, port: string, n: number): Cite | undefined {
  const r = view.reg(`${port}_AFR${n < 8 ? 'L' : 'H'}`);
  if (!r) return undefined;
  const f = r.decoded.fields.find((x) => x.field.name === `AFR${n < 8 ? 'L' : 'H'}${n}` || x.field.name === `AFR${n}`);
  return f ? cite(r, f.field.name) : undefined;
}

const modeText = (s: PinState) =>
  s.mode === 'af' ? 'alternate function' : s.mode === 'analog' ? 'analog' : s.mode === 'output' ? 'general-purpose output' : 'input';

// --- Targets: which peripherals and signals the pin checks look at --------

function targetsOf(device: DeviceJson, view: DumpView, question: string): string[] {
  const names = new Set<string>();
  for (const p of view.peripherals) if (TARGET_KIND.test(p)) names.add(p);
  for (const m of question.toUpperCase().matchAll(/\b([A-Z]+\d+)\b/g)) {
    if (TARGET_KIND.test(m[1]) && device.peripherals.some((p) => p.name === m[1])) names.add(m[1]);
  }
  return [...names].sort();
}

function signalsInUse(view: DumpView, p: string, question: string): string[] {
  const inDump = view.peripherals.has(p);
  const on = (key: string, field: string) => view.field(key, field) !== 0; // unknown counts as on
  if (/^(USART|UART|LPUART)/.test(p)) {
    if (inDump && view.field(`${p}_CR1`, 'UE') === 0) return [];
    const out: string[] = [];
    if (!inDump || on(`${p}_CR1`, 'TE')) out.push(`${p}_TX`);
    if (!inDump || on(`${p}_CR1`, 'RE')) out.push(`${p}_RX`);
    return out;
  }
  if (/^SPI/.test(p)) return !inDump || on(`${p}_CR1`, 'SPE') ? [`${p}_SCK`, `${p}_MOSI`, `${p}_MISO`] : [];
  if (/^I2C/.test(p)) return !inDump || on(`${p}_CR1`, 'PE') ? [`${p}_SCL`, `${p}_SDA`] : [];
  if (/^TIM/.test(p)) {
    const chans = new Set<number>();
    const q = question.toUpperCase();
    for (const m of q.matchAll(new RegExp(`\\b${p}[_ ]?CH(\\d)\\b`, 'g'))) chans.add(Number(m[1]));
    for (let n = 1; n <= 4; n++) {
      const e = view.field(`${p}_CCER`, `CC${n}E`);
      const mode = view.field(`${p}_CCMR${n <= 2 ? 1 : 2}_Output`, `OC${n}M`);
      if (e === 1 || (e === undefined && (mode === 6 || mode === 7))) chans.add(n);
    }
    return [...chans].sort().map((n) => `${p}_CH${n}`);
  }
  return [];
}

// --- Rules -----------------------------------------------------------------

function ruleClockOff(device: DeviceJson, view: DumpView, findings: Finding[], hints: string[]) {
  for (const p of [...view.peripherals].sort()) {
    if (p === 'RCC') continue;
    const en = enableBit(device, p);
    if (!en) continue;
    const reg = view.reg(en.register);
    if (!reg) {
      hints.push(`Add ${dumpCmd(device, en.register)} to check that ${p}'s clock is on (${en.field}).`);
      continue;
    }
    const c = cite(reg, en.field)!;
    if (c.value !== 0) continue;
    const regs = view.ofPeripheral(p);
    const allZero = regs.every((r) => r.value === 0);
    findings.push({
      rule: 'clock-off',
      severity: 'error',
      title: `${p} clock is off`,
      detail: allZero
        ? `${en.register}.${en.field} = 0, and every ${p} register in the dump reads 0x00000000. A peripheral with its clock off reads as zero and ignores writes, so the code that configured ${p} had no effect. Set ${en.field} = 1 before writing ${p}'s registers.`
        : `${en.register}.${en.field} = 0, yet ${p} registers hold non-zero values. A peripheral with its clock off ignores writes and reads as zero, so the clock was switched off after ${p} was set up, or the dump mixes reads from different moments.`,
      cites: [c],
    });
  }
}

function rulePinMux(device: DeviceJson, view: DumpView, fam: Family, targets: string[], question: string, findings: Finding[], hints: string[]) {
  const table = AF_TABLES[device.id];
  if (!table) return;
  const named = new Set([...question.toUpperCase().matchAll(/\bP([A-K])(\d{1,2})\b/g)].map((m) => `P${m[1]}${Number(m[2])}`));
  for (const p of targets) {
    for (const signal of signalsInUse(view, p, question)) {
      const rows = table.rows.filter((r) => r.signal === signal);
      if (!rows.length) continue;
      const portReg = (r: AfRow) => (fam === 'f1' ? `${r.port}_CR${r.n < 8 ? 'L' : 'H'}` : `${r.port}_MODER`);
      const dumped = rows.filter((r) => view.has(portReg(r)));
      const missing = rows.filter((r) => !view.has(portReg(r)));
      const missingText = missing.length
        ? `${signal} can also use ${missing.map((r) => r.pin).join(', ')}; add ${[...new Set(missing.map(portReg))].join(', ')} to check ${missing.length > 1 ? 'them' : 'it'}.`
        : '';
      if (!dumped.length) {
        hints.push(`To check ${signal}'s pin, add ${[...new Set(rows.map(portReg))].join(' or ')} (candidates: ${rows.map((r) => r.pin).join(', ')}).`);
        continue;
      }
      // Pins the question names go first, so findings talk about the pin you asked about.
      dumped.sort((a, b) => Number(named.has(b.pin)) - Number(named.has(a.pin)));
      const states = dumped.map((r) => ({ r, s: pinState(view, fam, r.port, r.n)!, af: fam === 'f1' ? undefined : afState(view, r.port, r.n) }));

      if (fam === 'f1') {
        const out = isOutputSignal(signal);
        if (out ? states.some(({ s }) => s.mode === 'af') : states.some(({ s }) => s.mode === 'input')) continue;
        const gp = states.find(({ s }) => s.mode === 'output');
        const odr = signal.includes('I2C') ? 'open-drain (CNF = 0b11)' : 'push-pull (CNF = 0b10)';
        if (out && gp) {
          findings.push({
            rule: 'pin-mux',
            severity: 'error',
            title: `${gp.r.pin} is a general-purpose output, not ${signal}`,
            detail: `${gp.r.pin} is set as an output with CNF${gp.r.n} = 0b${gp.s.cnf!.toString(2).padStart(2, '0')} (general-purpose ${gp.s.cnf ? 'open-drain' : 'push-pull'}), so the GPIO's ODR drives the pin and ${p} can't. ${signal} needs alternate-function ${odr} on ${gp.r.pin} (${table.source}; RegLens assumes no AFIO remap).`,
            cites: gp.s.cites,
          });
        } else if (out) {
          findings.push({
            rule: 'pin-mux',
            severity: missing.length ? 'info' : 'warn',
            title: `No dumped pin is set up for ${signal}`,
            detail: `${states.map(({ r, s }) => `${r.pin} is ${modeText(s)}`).join('; ')}. ${signal} needs alternate-function ${odr} with MODE ≠ 0b00. ${missingText}`.trim(),
            cites: states.flatMap(({ s }) => s.cites),
          });
        } else if (gp) {
          findings.push({
            rule: 'pin-mux',
            severity: 'warn',
            title: `${gp.r.pin} drives the line that ${signal} should read`,
            detail: `${gp.r.pin} is a general-purpose output, so it fights the signal coming into ${signal}. Inputs on the F103 use MODE = 0b00 with CNF = 0b01 (floating) or 0b10 (pull-up/down).`,
            cites: gp.s.cites,
          });
        }
        continue;
      }

      if (states.some(({ r, s, af }) => s.mode === 'af' && af?.value === r.af)) continue; // routed
      // A pin in AF mode with AF0 is usually a debug or system pin (SWD, JTAG, MCO); not a mis-route.
      const wrong = states.find(({ s, af }) => s.mode === 'af' && af !== undefined && af.value !== 0);
      if (wrong) {
        const af = wrong.af!;
        const other = table.rows.find((x) => x.pin === wrong.r.pin && x.af === af.value)?.signal;
        findings.push({
          rule: 'pin-mux',
          severity: 'error',
          title: `${wrong.r.pin} selects AF${af.value}, not ${signal}`,
          detail: `${wrong.r.pin} is in alternate-function mode, but ${af.register}.${af.field} = ${af.value} selects ${other ?? `a function RegLens's table doesn't list for ${wrong.r.pin}`}. ${signal} on ${wrong.r.pin} is AF${wrong.r.af} (${table.source}). Set ${af.field} = ${wrong.r.af}.`,
          cites: [...wrong.s.cites, af],
        });
        continue;
      }
      const afUnknown = states.find(({ s, af }) => s.mode === 'af' && af === undefined);
      if (afUnknown) {
        hints.push(`${afUnknown.r.pin} is in alternate-function mode; add ${dumpCmd(device, `${afUnknown.r.port}_AFR${afUnknown.r.n < 8 ? 'L' : 'H'}`)} to check it selects ${signal} (AF${afUnknown.r.af}).`);
        continue;
      }
      findings.push({
        rule: 'pin-mux',
        severity: missing.length ? 'info' : 'warn',
        title: `No dumped pin is routed to ${signal}`,
        detail: `${states.map(({ r, s, af }) => `${r.pin} is ${modeText(s)}${s.mode === 'af' && af ? ` AF${af.value}` : ''}`).join('; ')}. ${signal} needs MODER = 0b10 (Alternate) and AF${[...new Set(dumped.map((r) => r.af))].join('/')} on one of these pins. ${missingText}`.trim(),
        cites: states.flatMap(({ s, af }) => (af && s.mode === 'af' ? [...s.cites, af] : s.cites)),
      });
    }
  }
}

function ruleOutputAsInput(view: DumpView, fam: Family, question: string, findings: Finding[]) {
  const asked = OUTPUT_WORDS.test(question)
    ? new Set([...question.toUpperCase().matchAll(/\bP([A-K])(\d{1,2})\b/g)].map((m) => `GPIO${m[1]}:${Number(m[2])}`))
    : new Set<string>();
  const clockOff = new Set(findings.filter((f) => f.rule === 'clock-off').map((f) => f.title.split(' ')[0]));
  for (const port of [...view.peripherals].filter((p) => /^GPIO[A-K]$/.test(p)).sort()) {
    for (let n = 0; n < 16; n++) {
      const odr = view.reg(`${port}_ODR`);
      const odrCite = odr && cite(odr, `ODR${n}`);
      const byOdr = odrCite?.value === 1;
      const byQuestion = asked.has(`${port}:${n}`);
      if (!byOdr && !byQuestion) continue;
      const s = pinState(view, fam, port, n);
      if (!s || (s.mode !== 'input' && s.mode !== 'analog')) continue;
      // On the F103, ODR picks pull-up vs pull-down for a CNF = 0b10 input; that's normal.
      if (fam === 'f1' && s.cnf === 2 && !byQuestion) continue;
      const pin = `P${port.slice(4)}${n}`;
      const why = byOdr
        ? `ODR${n} = 1 asks ${pin} to drive high, but`
        : `You described ${pin} as an output, but`;
      const fix = fam === 'f1' ? `Set MODE${n} = 0b10 (2 MHz) or 0b11 (50 MHz) with CNF${n} = 0b00 (push-pull)` : `Set MODER${n} = 0b01 (Output)`;
      findings.push({
        rule: 'output-as-input',
        severity: 'warn',
        title: `${pin} is ${s.mode === 'analog' ? 'in analog mode' : 'an input'}, not an output`,
        detail: `${why} ${s.cites.map(citeText).join(' and ')} leaves the output driver off, so the pin doesn't drive. ${fix}.${clockOff.has(port) ? ` ${port}'s clock is off (see above), which is why its mode bits read 0.` : ''}`,
        cites: odrCite && byOdr ? [...s.cites, odrCite] : s.cites,
      });
    }
  }
}

function ruleNotEnabled(device: DeviceJson, view: DumpView, findings: Finding[], hints: string[]) {
  for (const p of [...view.peripherals].sort()) {
    const cr1 = view.reg(`${p}_CR1`);
    if (/^(USART|UART|LPUART)\d+$/.test(p) && cr1) {
      const ue = cite(cr1, 'UE');
      const te = cite(cr1, 'TE');
      const re = cite(cr1, 'RE');
      if (ue?.value === 0) {
        findings.push({
          rule: 'not-enabled',
          severity: 'error',
          title: `${p} is disabled`,
          detail: `${citeText(ue)}: nothing is sent or received until UE = 1. Set UE after BRR and the other CR1 bits.`,
          cites: [ue],
        });
      } else if (te && re && (te.value === 0 || re.value === 0)) {
        const off = [te.value === 0 && 'transmitter (TE)', re.value === 0 && 'receiver (RE)'].filter(Boolean).join(' and ');
        findings.push({
          rule: 'not-enabled',
          severity: te.value === 0 && re.value === 0 ? 'warn' : 'info',
          title: `${p} ${off} ${te.value === 0 && re.value === 0 ? 'are' : 'is'} off`,
          detail: `${[te, re].filter((c) => c.value === 0).map(citeText).join(', ')}. Fine for a one-way link; otherwise set ${te.value === 0 ? 'TE' : 'RE'} = 1.`,
          cites: [te, re].filter((c) => c.value === 0),
        });
      }
    }

    if (/^TIM\d+$/.test(p)) {
      const cen = cr1 && cite(cr1, 'CEN');
      const pwmChannels: number[] = [];
      for (let n = 1; n <= 4; n++) {
        const ccmr = view.reg(`${p}_CCMR${n <= 2 ? 1 : 2}_Output`);
        const mode = ccmr && cite(ccmr, `OC${n}M`);
        const ext = ccmr && cite(ccmr, `OC${n}M_3`);
        if (!mode || (mode.value !== 6 && mode.value !== 7) || ext?.value) continue;
        pwmChannels.push(n);
        const ccer = view.reg(`${p}_CCER`);
        const e = ccer && cite(ccer, `CC${n}E`);
        if (e?.value === 0) {
          findings.push({
            rule: 'not-enabled',
            severity: 'error',
            title: `${p} channel ${n} output is disabled`,
            detail: `${citeText(mode)} selects PWM on channel ${n}, but ${citeText(e)}, so the signal never leaves the timer. Set CC${n}E = 1.`,
            cites: [mode, e],
          });
        }
      }
      const arr = view.field(`${p}_ARR`, 'ARR');
      const arrReset = view.reg(`${p}_ARR`)?.register.reset;
      const configured = pwmChannels.length > 0 || (arr !== undefined && arr !== arrReset) || !!view.field(`${p}_PSC`, 'PSC');
      if (cen?.value === 0 && configured) {
        findings.push({
          rule: 'not-enabled',
          severity: 'warn',
          title: `${p} counter is stopped`,
          detail: `${citeText(cen)}: the timer is configured but not counting, so no PWM or update events happen. Set CEN = 1 last, after PSC, ARR and the channels.`,
          cites: [cen],
        });
      }
      const anyOn = [1, 2, 3, 4].some((n) => view.field(`${p}_CCER`, `CC${n}E`) === 1);
      const bdtrInSvd = !!lookupKey(device, `${p}_BDTR`);
      if (bdtrInSvd && anyOn) {
        const bdtr = view.reg(`${p}_BDTR`);
        const moe = bdtr && cite(bdtr, 'MOE');
        if (!bdtr) hints.push(`${p} has a break/dead-time unit: add ${dumpCmd(device, `${p}_BDTR`)} to check MOE, which gates every ${p} output.`);
        else if (moe?.value === 0) {
          findings.push({
            rule: 'not-enabled',
            severity: 'error',
            title: `${p} outputs are held off by MOE`,
            detail: `${citeText(moe)}. ${p} is an advanced-control timer: its channel outputs stay inactive until BDTR.MOE = 1, even with CCxE set. HAL sets it in HAL_TIM_PWM_Start; bare-metal code often forgets.`,
            cites: [moe],
          });
        }
      }
    }
  }
}

// --- Computed quantities ------------------------------------------------------

/** RM0090/RM0383/RM0008: baud = f_CK / (8 × (2 − OVER8) × USARTDIV), USARTDIV = mantissa + fraction/16 (or /8 with OVER8). */
export function usartBaudF4(fck: number, mantissa: number, fraction: number, over8: number): { baud: number; usartdiv: number } {
  const usartdiv = mantissa + (over8 ? (fraction % 8) / 8 : fraction / 16);
  return { usartdiv, baud: usartdiv ? fck / (8 * (2 - over8) * usartdiv) : NaN };
}

/** RM0433 (H7): OVER16 baud = f_ker / BRR; OVER8 baud = 2 × f_ker / USARTDIV, USARTDIV = BRR[15:4] << 4 | BRR[2:0] << 1. */
export function usartBaudH7(fker: number, brr: number, over8: number): { baud: number; usartdiv: number } {
  const usartdiv = over8 ? Math.floor(brr / 16) * 16 + (brr % 8) * 2 : brr;
  return { usartdiv, baud: usartdiv ? (over8 ? (2 * fker) / usartdiv : fker / usartdiv) : NaN };
}

/** BRR value for a target baud (F1/F4 mantissa/fraction layout). */
export function brrForF4(fck: number, baud: number, over8: number): number {
  const div = fck / (8 * (2 - over8) * baud);
  let mant = Math.floor(div);
  let frac = Math.round((div - mant) * (over8 ? 8 : 16));
  if (frac === (over8 ? 8 : 16)) {
    mant += 1;
    frac = 0;
  }
  return mant * 16 + frac;
}

/**
 * Timer PWM, RM0090/RM0383/RM0008/RM0433 "PWM mode": edge-aligned period = (PSC+1)(ARR+1)
 * timer ticks; center-aligned = (PSC+1) × 2 × ARR. Duty is the share of the period the
 * channel reference OCxREF is active: PWM mode 1 upcounting = CCR / (ARR+1), clamped to 100%;
 * downcounting = (CCR+1) / (ARR+1); center-aligned = CCR / ARR. PWM mode 2 inverts it.
 */
export function timerPwm(
  fTim: number,
  psc: number,
  arr: number,
  ccr: number,
  opts: { mode2?: boolean; cms?: number; down?: boolean } = {},
): { freqHz: number; dutyPct: number } {
  const center = !!opts.cms;
  const counts = center ? 2 * arr : arr + 1;
  const freqHz = counts ? fTim / ((psc + 1) * counts) : NaN;
  let active: number;
  if (center) active = arr ? Math.min(ccr, arr) / arr : 0;
  else if (opts.down) active = Math.min(ccr + 1, arr + 1) / (arr + 1);
  else active = Math.min(ccr, arr + 1) / (arr + 1);
  if (opts.mode2) active = 1 - active;
  return { freqHz, dutyPct: active * 100 };
}

function nearestStandard(baud: number): number {
  return STANDARD_BAUDS.reduce((best, b) => (Math.abs(Math.log(b / baud)) < Math.abs(Math.log(best / baud)) ? b : best));
}

/** A baud rate the developer mentioned: "at 115200", "9600 baud". */
export function baudFromQuestion(question: string): number | undefined {
  for (const m of question.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{3,7})\s*(baud|bps|bd)?\b/gi)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (m[2] || STANDARD_BAUDS.includes(v)) return v;
  }
  return undefined;
}

function namedClocks(fam: Family, clocks: Clocks, hse?: number): { name: string; hz: number }[] {
  const list: { name: string; hz: number }[] = [];
  const add = (name: string, hz?: number) => hz && !list.some((x) => Math.abs(x.hz - hz) < 1) && list.push({ name, hz });
  add('HSI', fam === 'f4' ? 16e6 : fam === 'f1' ? 8e6 : fam === 'h7' ? 64e6 : undefined);
  add('HSE', hse);
  add('SYSCLK', clocks.sysclk.hz);
  add('HCLK', clocks.hclk.hz);
  add('PCLK1', clocks.pclk1.hz);
  add('PCLK2', clocks.pclk2.hz);
  return list;
}

function usartQuantity(device: DeviceJson, view: DumpView, fam: Family, p: string, clocks: Clocks, o: DoctorOptions): Quantity | undefined {
  const brr = view.reg(`${p}_BRR`);
  if (!brr) return undefined;
  const cr1 = view.reg(`${p}_CR1`);
  const over8Cite = cr1 && cite(cr1, 'OVER8');
  const over8 = over8Cite?.value ?? 0;
  const { pclk, bus } = clockFor(device, clocks, p);
  const h7 = brr.decoded.fields.some((f) => f.field.name === 'BRR');
  const cites: Cite[] = h7 ? [cite(brr, 'BRR')!] : [cite(brr, 'DIV_Mantissa')!, cite(brr, 'DIV_Fraction')!];
  if (over8Cite) cites.push(over8Cite);
  const busName = bus === 'apb1' ? 'APB1' : bus === 'apb2' ? 'APB2' : bus.toUpperCase();
  const q: Quantity = { kind: 'baud', peripheral: p, title: `${p} baud rate`, lines: [], cites, numbers: {} };
  if (pclk.hz === undefined) {
    q.needs = `the ${busName} clock: add RCC_CFGR${fam === 'f4' ? ' and RCC_PLLCFGR' : ''} to the dump, or type the ${busName} clock`;
    return q;
  }
  let fck = pclk.hz;
  let res: { baud: number; usartdiv: number };
  if (h7) {
    const presc = view.reg(`${p}_PRESC`);
    const pc = presc && cite(presc, 'PRESCALER');
    const div = pc ? [1, 2, 4, 6, 8, 10, 12, 16, 32, 64, 128, 256][pc.value] ?? 256 : 1;
    if (pc) cites.push(pc);
    fck = pclk.hz / div;
    res = usartBaudH7(fck, cites[0].value, over8);
    q.lines.push(
      `kernel clock = ${busName} ${formatMHz(pclk.hz)}${div > 1 ? ` / PRESC ${div}` : ''} (RegLens assumes the default PCLK kernel clock)`,
      over8 ? `baud = 2 × ${formatMHz(fck)} / USARTDIV ${res.usartdiv}` : `baud = ${formatMHz(fck)} / BRR ${res.usartdiv}`,
    );
  } else {
    const mant = cites[0].value;
    const frac = cites[1].value;
    res = usartBaudF4(fck, mant, frac, over8);
    q.lines.push(
      `USARTDIV = ${mant} + ${over8 ? frac % 8 : frac}/${over8 ? 8 : 16} = ${+res.usartdiv.toFixed(4)}`,
      `baud = ${formatMHz(fck)} (${busName}) / (${over8 ? 8 : 16} × ${+res.usartdiv.toFixed(4)})`,
    );
  }
  if (!res.usartdiv) {
    q.needs = 'a non-zero BRR (BRR = 0 means the baud generator is off)';
    return q;
  }
  const baud = res.baud;
  const target = o.targetBaud ?? baudFromQuestion(o.question ?? '');
  q.numbers = { baud, clockHz: fck };
  q.display = `${fmtInt(baud)} baud`;
  q.lines.push(`= ${fmtInt(baud)} baud`);
  if (target) {
    const err = ((baud - target) / target) * 100;
    q.numbers.target = target;
    q.numbers.errorPct = err;
    q.numbers.impliedHz = (fck * target) / baud;
    q.lines.push(`target ${fmtInt(target)} baud → error ${fmtPct(err, true)}`);
    if (Math.abs(err) > 2) {
      const named = namedClocks(fam, clocks, o.hseHz).find((c) => Math.abs(c.hz - q.numbers.impliedHz!) / c.hz < 0.01);
      q.lines.push(`this BRR gives ${fmtInt(target)} baud only with a ${formatMHz(q.numbers.impliedHz)}${named ? ` (${named.name})` : ''} clock`);
    }
  } else {
    const std = nearestStandard(baud);
    const err = ((baud - std) / std) * 100;
    q.numbers.target = std;
    q.numbers.errorPct = err;
    q.lines.push(`nearest standard rate ${fmtInt(std)} baud → ${fmtPct(err, true)} (type a target baud to compare with yours)`);
  }
  return q;
}

function timerQuantities(device: DeviceJson, view: DumpView, p: string, clocks: Clocks): Quantity[] {
  const pscReg = view.reg(`${p}_PSC`);
  const arrReg = view.reg(`${p}_ARR`);
  const out: Quantity[] = [];
  if (!pscReg || !arrReg) {
    if (view.has(`${p}_CCMR1_Output`) || view.has(`${p}_CCR1`)) {
      out.push({ kind: 'update', peripheral: p, title: `${p} frequency`, lines: [], cites: [], needs: `${p}_PSC and ${p}_ARR in the dump`, numbers: {} });
    }
    return out;
  }
  const psc = cite(pscReg, 'PSC')!;
  const arr = cite(arrReg, 'ARR')!;
  const cr1 = view.reg(`${p}_CR1`);
  const cms = cr1 && cite(cr1, 'CMS');
  const dir = cr1 && cite(cr1, 'DIR');
  const { tim, bus } = clockFor(device, clocks, p);
  const base = [psc, arr, ...(cms?.value ? [cms] : []), ...(dir?.value ? [dir] : [])];
  const busName = bus === 'apb1' ? 'APB1' : 'APB2';
  const period = cms?.value ? `(PSC ${psc.value} + 1) × 2 × ARR ${arr.value}` : `(PSC ${psc.value} + 1) × (ARR ${arr.value} + 1)`;

  const channels: { n: number; mode: Cite; ccr: Cite; pol?: Cite; en?: Cite }[] = [];
  for (let n = 1; n <= 4; n++) {
    const ccmr = view.reg(`${p}_CCMR${n <= 2 ? 1 : 2}_Output`);
    const mode = ccmr && cite(ccmr, `OC${n}M`);
    const ext = ccmr && cite(ccmr, `OC${n}M_3`);
    const ccrReg = view.reg(`${p}_CCR${n}`);
    if (!mode || (mode.value !== 6 && mode.value !== 7) || ext?.value || !ccrReg) continue;
    const ccer = view.reg(`${p}_CCER`);
    channels.push({ n, mode, ccr: cite(ccrReg, ccrReg.decoded.fields[0].field.name)!, pol: ccer && cite(ccer, `CC${n}P`), en: ccer && cite(ccer, `CC${n}E`) });
  }

  const needs = tim.hz === undefined ? `the ${busName} timer clock: add RCC_CFGR (and the PLL registers) to the dump, or type it` : undefined;
  if (!channels.length) {
    const q: Quantity = { kind: 'update', peripheral: p, title: `${p} update rate`, lines: [], cites: base, needs, numbers: {} };
    if (tim.hz !== undefined) {
      const { freqHz } = timerPwm(tim.hz, psc.value, arr.value, 0, { cms: cms?.value });
      q.numbers = { freqHz, clockHz: tim.hz };
      q.display = fmtHz(freqHz);
      q.lines.push(`f = ${formatMHz(tim.hz)} / (${period}) = ${fmtHz(freqHz)}`);
    }
    return [q];
  }
  for (const ch of channels) {
    const q: Quantity = {
      kind: 'pwm',
      peripheral: p,
      channel: ch.n,
      title: `${p} CH${ch.n} PWM`,
      lines: [],
      cites: [...base, ch.mode, ch.ccr, ...(ch.pol?.value ? [ch.pol] : [])],
      needs,
      numbers: {},
    };
    if (tim.hz !== undefined) {
      const r = timerPwm(tim.hz, psc.value, arr.value, ch.ccr.value, { mode2: ch.mode.value === 7, cms: cms?.value, down: dir?.value === 1 });
      q.numbers = { freqHz: r.freqHz, dutyPct: r.dutyPct, clockHz: tim.hz };
      q.display = `${fmtHz(r.freqHz)}, ${fmtPct(r.dutyPct)} duty`;
      q.lines.push(`f = ${formatMHz(tim.hz)} (${busName} timers) / (${period}) = ${fmtHz(r.freqHz)}`);
      const dutyExpr = cms?.value
        ? `CCR${ch.n} ${ch.ccr.value} / ARR ${arr.value}`
        : dir?.value === 1
          ? `(CCR${ch.n} ${ch.ccr.value} + 1) / (ARR ${arr.value} + 1)`
          : `CCR${ch.n} ${ch.ccr.value} / (ARR ${arr.value} + 1)`;
      q.lines.push(`duty = ${ch.mode.value === 7 ? `1 − ${dutyExpr} (PWM mode 2)` : dutyExpr} = ${fmtPct(r.dutyPct)}`);
      if (ch.pol?.value) q.lines.push(`CC${ch.n}P = 1: active-low, so the pin is low for ${fmtPct(r.dutyPct)} of each period`);
      if (ch.en?.value === 0) q.lines.push(`CC${ch.n}E = 0: this waveform is not reaching the pin`);
    }
    out.push(q);
  }
  return out;
}

function ruleBaud(quantities: Quantity[], o: DoctorOptions, findings: Finding[]) {
  for (const q of quantities) {
    if (q.kind !== 'baud' || q.numbers.baud === undefined || q.numbers.errorPct === undefined) continue;
    const err = q.numbers.errorPct;
    if (Math.abs(err) <= 2) continue;
    const explicit = o.targetBaud ?? baudFromQuestion(o.question ?? '');
    const target = q.numbers.target!;
    const fck = q.numbers.clockHz!;
    const brrFix = q.cites[0].field === 'BRR' ? `BRR = ${Math.round(fck / target)}` : `BRR = ${hex(brrForF4(fck, target, 0), 16)} for ${fmtInt(target)} baud at ${formatMHz(fck)} (16× oversampling)`;
    const implied = q.lines.find((l) => l.startsWith('this BRR gives'));
    findings.push({
      rule: 'baud-error',
      severity: explicit ? 'error' : 'warn',
      title: explicit
        ? `${q.peripheral} runs at ${fmtInt(q.numbers.baud)} baud, not ${fmtInt(target)}`
        : `${q.peripheral} baud ${fmtInt(q.numbers.baud)} isn't within 2% of a standard rate`,
      detail: `${fmtPct(err, true)} from ${fmtInt(target)} baud; UART links tolerate roughly ±2% in total. ${implied ? `${implied[0].toUpperCase()}${implied.slice(1)}, but ${q.peripheral}'s clock is ${formatMHz(fck)}. ` : ''}${explicit ? `Use ${brrFix}.` : 'If you meant a different rate, type it as the target.'}`,
      cites: q.cites,
    });
  }
}

// --- Entry point -------------------------------------------------------------

export function diagnose(device: DeviceJson, dump: MappedDump, o: DoctorOptions = {}): Diagnosis {
  const view = new DumpView(dump);
  const fam = family(device);
  const question = o.question ?? '';
  const clocks = deriveClocks(device, view, o);
  const findings: Finding[] = [];
  const hints: string[] = [];
  const targets = targetsOf(device, view, question);

  ruleClockOff(device, view, findings, hints);
  rulePinMux(device, view, fam, targets, question, findings, hints);
  ruleOutputAsInput(view, fam, question, findings);
  ruleNotEnabled(device, view, findings, hints);

  const quantities: Quantity[] = [];
  for (const p of [...view.peripherals].sort()) {
    if (/^(USART|UART|LPUART)\d+$/.test(p)) {
      const q = usartQuantity(device, view, fam, p, clocks, o);
      if (q) quantities.push(q);
    } else if (/^TIM\d+$/.test(p)) {
      quantities.push(...timerQuantities(device, view, p, clocks));
    }
  }
  ruleBaud(quantities, o, findings);

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { family: fam, clocks, findings, quantities, hints: [...new Set(hints)], targets };
}

// --- For the Explain function -------------------------------------------------

/** Plain-text facts for the model: findings, numbers, clocks and changed fields. */
export function doctorFactsText(device: DeviceJson, dump: MappedDump, dx: Diagnosis): string {
  const lines: string[] = [];
  const periphs = [...new Set(dump.registers.map((r) => r.peripheral.name))];
  lines.push(`Chip ${device.name}. Dump: ${dump.registers.length} registers from ${periphs.join(', ')}.`);
  const c = dx.clocks;
  const clk = (label: string, k: keyof Pick<Clocks, 'sysclk' | 'hclk' | 'pclk1' | 'pclk2' | 'tim1' | 'tim2'>) =>
    c[k].hz !== undefined ? `${label} ${formatMHz(c[k].hz!)} (${c[k].source === 'manual' ? 'typed in' : 'from RCC'})` : undefined;
  const clocks = [clk('SYSCLK', 'sysclk'), clk('HCLK', 'hclk'), clk('APB1', 'pclk1'), clk('APB2', 'pclk2'), clk('APB1 timers', 'tim1'), clk('APB2 timers', 'tim2')].filter(Boolean);
  lines.push(`Clocks: ${clocks.length ? clocks.join(', ') : 'unknown'}.`);
  lines.push('', 'Findings from RegLens rules, most severe first:');
  if (!dx.findings.length) lines.push('none: no rule found a cross-register problem.');
  dx.findings.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.severity}] ${f.title}. ${f.detail}`);
    if (f.cites.length) lines.push(`   Evidence: ${f.cites.map(citeText).join('; ')}`);
  });
  lines.push('', 'Computed:');
  if (!dx.quantities.length) lines.push('none.');
  for (const q of dx.quantities) {
    lines.push(`- ${q.title}: ${q.display ?? `not computed, needs ${q.needs}`}`);
    for (const l of q.lines) lines.push(`    ${l}`);
  }
  lines.push('', 'Fields that differ from reset (REGISTER.FIELD = value):');
  for (const r of dump.registers) {
    const changed = r.decoded.fields.filter((f) => f.changedFromReset);
    if (!changed.length) continue;
    lines.push(`- ${changed.slice(0, 12).map((f) => citeText(cite(r, f.field.name)!)).join('; ')}${changed.length > 12 ? `; and ${changed.length - 12} more` : ''}`);
  }
  if (dx.hints.length) lines.push('', 'Registers missing from the dump:', ...dx.hints.map((h) => `- ${h}`));
  return lines.join('\n');
}

/** Deterministic summary used when the model's reply fails verification, or without a key. */
export function findingsSummary(dx: Diagnosis): string {
  const lines: string[] = [];
  if (!dx.findings.length) lines.push("RegLens's rules found no cross-register problem in this dump.");
  else lines.push(`RegLens found ${dx.findings.length} issue${dx.findings.length > 1 ? 's' : ''}:`);
  for (const f of dx.findings.slice(0, 6)) lines.push(`- ${f.title}. ${f.cites.map(citeText).join('; ')}`);
  for (const q of dx.quantities) if (q.display) lines.push(`- ${q.title}: ${q.display}`);
  return lines.join('\n');
}

const UNIT_KIND: Record<string, 'hz' | 'baud' | 'pct'> = { hz: 'hz', khz: 'hz', mhz: 'hz', baud: 'baud', bps: 'baud', bd: 'baud', '%': 'pct' };
const UNIT_SCALE: Record<string, number> = { hz: 1, khz: 1e3, mhz: 1e6 };

/**
 * Check a doctor summary: every REGISTER.FIELD = value and FIELD = value claim
 * must match the dump, and every number with a unit (Hz, baud, %) must be one
 * RegLens computed. Returns the misstatements.
 */
export function verifyDoctorReply(text: string, dump: MappedDump, dx: Diagnosis, o: DoctorOptions = {}): string[] {
  const errors: string[] = [];
  const qualified = new Map<string, number>();
  const bare = new Map<string, Set<number>>();
  for (const r of dump.registers) {
    for (const f of r.decoded.fields) {
      qualified.set(`${r.key}.${f.field.name}`.toUpperCase(), f.value);
      const s = bare.get(f.field.name.toUpperCase()) ?? new Set<number>();
      s.add(f.value);
      bare.set(f.field.name.toUpperCase(), s);
    }
  }
  const regKeys = new Set(dump.registers.map((r) => r.key.toUpperCase()));
  const num = (s: string) => (/^0b/i.test(s) ? parseInt(s.slice(2), 2) : /^0x/i.test(s) ? parseInt(s.slice(2), 16) : Number(s));
  // Values the findings themselves propose as fixes ("Set AFRL0 = 1") are fair to repeat.
  const suggested = new Map<string, Set<number>>();
  const facts = [...dx.findings.map((f) => f.detail), ...dx.quantities.flatMap((q) => q.lines), ...dx.hints].join('\n');
  for (const m of facts.matchAll(/\b([A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)?)\s*=\s*(0b[01]+|0x[0-9a-f]+|\d+)\b/gi)) {
    const k = m[1].toUpperCase();
    const set = suggested.get(k) ?? new Set<number>();
    set.add(num(m[2]));
    suggested.set(k, set);
    const bareName = k.split('.').pop()!;
    const b = suggested.get(bareName) ?? new Set<number>();
    b.add(num(m[2]));
    suggested.set(bareName, b);
  }
  const okSuggested = (k: string, v: number) => suggested.get(k)?.has(v) ?? false;

  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)\s*=\s*(0b[01]+|0x[0-9a-f]+|\d+)\b/gi)) {
    const key = `${m[1]}.${m[2]}`.toUpperCase();
    const v = num(m[3]);
    if (qualified.has(key)) {
      if (qualified.get(key) !== v && !okSuggested(key, v) && !okSuggested(m[2].toUpperCase(), v)) errors.push(`${key} is ${qualified.get(key)}, not ${m[3]}`);
    } else if (regKeys.has(m[1].toUpperCase())) {
      errors.push(`${m[1]} has no field ${m[2]}`);
    }
  }
  for (const m of text.matchAll(/(?<![.\w])([A-Z][A-Z0-9_]+)\s*=\s*(0b[01]+|0x[0-9a-f]+|\d+)\b/g)) {
    const values = bare.get(m[1].toUpperCase());
    if (!values) continue;
    const v = num(m[2]);
    if (!values.has(v) && !okSuggested(m[1].toUpperCase(), v)) errors.push(`${m[1]} is ${[...values].join(' or ')} in the dump, not ${m[2]}`);
  }

  // Numbers with units must be ones RegLens computed (or the 2% tolerance it states).
  const allowed: Record<'hz' | 'baud' | 'pct', number[]> = { hz: [], baud: [], pct: [2] };
  const c = dx.clocks;
  for (const k of ['sysclk', 'hclk', 'pclk1', 'pclk2', 'tim1', 'tim2'] as const) if (c[k].hz) allowed.hz.push(c[k].hz!);
  if (o.hseHz) allowed.hz.push(o.hseHz);
  allowed.hz.push(16e6, 8e6, 64e6); // internal oscillators
  for (const q of dx.quantities) {
    const n = q.numbers;
    for (const v of [n.freqHz, n.impliedHz, n.clockHz]) if (v) allowed.hz.push(v);
    for (const v of [n.baud, n.target]) if (v) allowed.baud.push(v);
    for (const v of [n.errorPct, n.dutyPct]) if (v !== undefined) allowed.pct.push(Math.abs(v), 100 - Math.abs(v));
  }
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(MHz|kHz|Hz|baud|bps|Bd|%)/gi)) {
    const unit = m[2].toLowerCase();
    const kind = UNIT_KIND[unit];
    const v = Number(m[1].replace(/,/g, '')) * (UNIT_SCALE[unit] ?? 1);
    const ok = allowed[kind].some((a) => (kind === 'pct' ? Math.abs(a - v) <= Math.max(0.051, Math.abs(a) * 0.01) : Math.abs(a - v) <= Math.abs(a) * 0.005 + 0.5));
    if (!ok) errors.push(`${m[0]} isn't a number RegLens computed`);
  }
  return [...new Set(errors)];
}

export { STANDARD_BAUDS };
