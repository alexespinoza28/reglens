// Write mode: the AI proposes register values for a plain-English request, and
// this file decides whether to believe it. Nothing here calls a model.
//
// verifyProposal() checks, in order:
//   1. every register and field exists in the chip's SVD and is writable;
//   2. every value fits its field and, where the SVD names values, is a named one;
//   3. the meaning the AI claims for each value is the SVD's name for it;
//   4. the request's own words and numbers match (output / push-pull / no pull /
//      AF7, baud at a stated clock, PWM frequency and duty at a stated clock);
//   5. the C lines, run in a tiny interpreter from several start values, set
//      exactly the proposed fields and leave every other bit alone.
// A proposal is verified only if every check passes.

import { bits, decode, findMeaning, hex, lookupKey, type DecodedRegister } from './decode.js';
import { enableBit, family, type Family } from './clocks.js';
import { timerPwm, usartBaudF4, usartBaudH7 } from './doctor.js';
import type { DeviceJson, FieldJson, PeripheralJson, RegisterJson } from './types.js';

export interface ProposedField {
  name: string;
  value: number;
  meaning?: string;
}

export interface ProposedWrite {
  register: string;
  fields: ProposedField[];
}

export interface Proposal {
  writes: ProposedWrite[];
  c: string[];
  notes?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'note';
export interface Check {
  status: CheckStatus;
  text: string;
}

export interface WriteResult {
  key: string;
  peripheral: PeripheralJson;
  register: RegisterJson;
  /** Register value after the C lines run from the reset value. */
  value: number;
  decoded: DecodedRegister;
  fields: { field: FieldJson; value: number; svdMeaning?: string; claimed?: string }[];
}

export interface Verification {
  verified: boolean;
  checks: Check[];
  results: WriteResult[];
}

type Hit = { peripheral: PeripheralJson; register: RegisterJson };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** C spelling of a register for the prompt: GPIOA_AFRL -> GPIOA->AFR[0], TIM2_CCMR1_Output -> TIM2->CCMR1. */
export function cName(peripheral: string, register: string): string {
  const r = register === 'AFRL' ? 'AFR[0]' : register === 'AFRH' ? 'AFR[1]' : register.replace(/_(Output|Input)$/, '');
  return `${peripheral}->${r}`;
}

/** Resolve a register name from the model (GPIOA_MODER, GPIOA->MODER, GPIOA->AFR[0], TIM2->CCMR1). */
export function resolveRegister(device: DeviceJson, name: string, prefer: string[] = []): Hit | undefined {
  const key = name.trim().toUpperCase().replace(/\[(\d)\]/g, '$1').replace(/\s*(->|\.)\s*/g, '_');
  const tryKey = (k: string) => {
    const h = lookupKey(device, k);
    return h ?? device.peripherals
      .flatMap((p) => p.registers.map((r) => ({ peripheral: p, register: r })))
      .find((x) => `${x.peripheral.name}_${x.register.name}`.toUpperCase() === k.toUpperCase());
  };
  const direct = tryKey(key);
  if (direct) return direct;
  const afr = key.match(/^(.*_AFR)([01])$/);
  if (afr) return tryKey(`${afr[1]}${afr[2] === '0' ? 'L' : 'H'}`);
  const ccmr = key.match(/^(.*_CCMR\d)$/);
  if (ccmr) {
    const keys = [`${ccmr[1]}_Output`, `${ccmr[1]}_Input`];
    const preferred = keys.find((k) => prefer.some((p) => p.toUpperCase() === k.toUpperCase()));
    return tryKey(preferred ?? keys[0]);
  }
  return undefined;
}

// --- Parsing the model's reply -------------------------------------------------

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().replace(/[uUlL]+$/, '');
  if (/^0b[01]+$/i.test(t)) return parseInt(t.slice(2), 2);
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^\d+$/.test(t)) return Number(t);
  return undefined;
}

/** Pull the proposal JSON out of a model reply (tolerates code fences and prose around it). */
export function parseProposal(text: string): Proposal | { error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'reply had no JSON object' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { error: 'reply JSON did not parse' };
  }
  const o = raw as { writes?: unknown; c?: unknown; notes?: unknown };
  if (!Array.isArray(o.writes)) return { error: 'reply JSON has no "writes" array' };
  const writes: ProposedWrite[] = [];
  for (const w of o.writes as { register?: unknown; fields?: unknown }[]) {
    if (typeof w?.register !== 'string') return { error: 'a write has no register name' };
    const fields: ProposedField[] = [];
    type RawField = { name?: unknown; value?: unknown; meaning?: unknown };
    const list: RawField[] = Array.isArray(w.fields)
      ? (w.fields as RawField[])
      : w.fields && typeof w.fields === 'object'
        ? Object.entries(w.fields as Record<string, unknown>).map(([name, value]) => ({ name, value }))
        : [];
    for (const f of list) {
      const value = toInt(f.value);
      if (typeof f.name !== 'string' || value === undefined) return { error: `field ${String(f.name)} has no integer value` };
      fields.push({ name: f.name, value, meaning: typeof f.meaning === 'string' && f.meaning.trim() ? f.meaning.trim() : undefined });
    }
    writes.push({ register: w.register, fields });
  }
  const c = (Array.isArray(o.c) ? o.c : typeof o.c === 'string' ? [o.c] : []).filter((x): x is string => typeof x === 'string');
  return { writes, c, notes: typeof o.notes === 'string' ? o.notes.slice(0, 300) : undefined };
}

// --- A tiny C interpreter for register writes ------------------------------------

const TYPE_WORDS = /^(?:u?int(?:8|16|32)_t|unsigned|signed|int|long|volatile|const)$/;

type Tok = { t: 'num'; v: bigint } | { t: 'reg'; key: string } | { t: 'op'; v: string } | { t: 'id'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(0x[0-9a-f]+|0b[01]+|\d+)[uUlL]*|([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)(?:\s*\[\s*(\d+)\s*\])?|([A-Za-z_]\w*)|(<<|>>|\|=|&=|\^=|[=~|&^+\-*()]))/giy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < src.length && (m = re.exec(src))) {
    pos = re.lastIndex;
    if (m[1]) {
      const s = m[1].toLowerCase();
      out.push({ t: 'num', v: s.startsWith('0b') ? BigInt(parseInt(s.slice(2), 2)) : BigInt(s) });
    } else if (m[2]) out.push({ t: 'reg', key: `${m[2]}->${m[3]}${m[4] !== undefined ? `[${m[4]}]` : ''}` });
    else if (m[5]) out.push({ t: 'id', v: m[5] });
    else if (m[6]) out.push({ t: 'op', v: m[6] });
  }
  if (src.slice(pos).trim()) throw new Error(`can't read "${src.slice(pos).trim().slice(0, 20)}"`);
  return out;
}

const M32 = 0xffffffffn;

/**
 * Run `PERIPH->REG op expr;` statements. Integer literals, ~ << >> | & ^ + - *,
 * parentheses and casts only; any other identifier (a CMSIS macro, a variable)
 * makes the line uncheckable, so it fails.
 */
export function runC(
  statements: string[],
  env: Map<string, number>,
  resolve: (cname: string) => string | undefined,
  sizeOf: (key: string) => number,
): { written: Set<string> } {
  const written = new Set<string>();
  for (const raw of statements) {
    const stmt = raw.trim().replace(/;$/, '');
    if (!stmt) continue;
    const toks = tokenize(stmt);
    let i = 0;
    const peek = () => toks[i];
    const eat = (v?: string) => {
      const t = toks[i++];
      if (v && !(t && t.t === 'op' && t.v === v)) throw new Error(`expected "${v}"`);
      return t;
    };
    const regValue = (cname: string): bigint => {
      const key = resolve(cname);
      if (!key) throw new Error(`${cname} is not a register on this chip`);
      return BigInt(env.get(key) ?? 0);
    };
    const primary = (): bigint => {
      const t = eat();
      if (!t) throw new Error('expression ends early');
      if (t.t === 'num') return t.v & M32;
      if (t.t === 'reg') return regValue(t.key);
      if (t.t === 'id') throw new Error(`"${t.v}" is a name RegLens can't evaluate; use numeric literals`);
      if (t.v === '(') {
        // Cast: (uint32_t) x
        if (peek()?.t === 'id' && TYPE_WORDS.test((peek() as { v: string }).v)) {
          while (peek()?.t === 'id' && TYPE_WORDS.test((peek() as { v: string }).v)) i++;
          eat(')');
          return unary();
        }
        const v = expr();
        eat(')');
        return v;
      }
      throw new Error(`unexpected "${t.v}"`);
    };
    const unary = (): bigint => {
      const t = peek();
      if (t?.t === 'op' && t.v === '~') return (eat(), ~unary() & M32);
      if (t?.t === 'op' && t.v === '-') return (eat(), -unary() & M32);
      if (t?.t === 'op' && t.v === '+') return (eat(), unary());
      return primary();
    };
    const binary = (next: () => bigint, ops: string[], apply: (a: bigint, op: string, b: bigint) => bigint) => (): bigint => {
      let a = next();
      for (let t = peek(); t?.t === 'op' && ops.includes(t.v); t = peek()) {
        eat();
        a = apply(a, t.v, next()) & M32;
      }
      return a;
    };
    const mul = binary(unary, ['*'], (a, _o, b) => a * b);
    const add = binary(mul, ['+', '-'], (a, o, b) => (o === '+' ? a + b : a - b));
    const shift = binary(add, ['<<', '>>'], (a, o, b) => {
      if (b > 31n) throw new Error('shift by 32 or more');
      return o === '<<' ? a << b : a >> b;
    });
    const and = binary(shift, ['&'], (a, _o, b) => a & b);
    const xor = binary(and, ['^'], (a, _o, b) => a ^ b);
    const expr = binary(xor, ['|'], (a, _o, b) => a | b);

    const lhs = eat();
    if (!lhs || lhs.t !== 'reg') throw new Error('each line must assign to PERIPH->REG');
    const key = resolve(lhs.key);
    if (!key) throw new Error(`${lhs.key} is not a register on this chip`);
    const op = eat();
    if (!op || op.t !== 'op' || !['=', '|=', '&=', '^='].includes(op.v)) throw new Error('expected =, |=, &= or ^=');
    const rhs = expr();
    if (i < toks.length) throw new Error('extra tokens after the expression');
    const cur = BigInt(env.get(key) ?? 0);
    const v = op.v === '=' ? rhs : op.v === '|=' ? cur | rhs : op.v === '&=' ? cur & rhs : cur ^ rhs;
    env.set(key, Number(v & ((1n << BigInt(sizeOf(key))) - 1n)));
    written.add(key);
  }
  return { written };
}

/** Split C text into statements. */
export function splitC(lines: string[]): string[] {
  return lines
    .join('\n')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- What the request asks for -----------------------------------------------------

export interface Intent {
  pins: { port: string; n: number; pin: string }[];
  mode?: 'input' | 'output' | 'af' | 'analog';
  otype?: 0 | 1;
  pull?: 0 | 1 | 2;
  af?: number;
  speedMHz?: number;
  baud?: number;
  clockHz?: number;
  pwmHz?: number;
  dutyPct?: number;
  channel?: number;
  over8?: 0 | 1;
}

export function parseIntent(request: string): Intent {
  const r = request;
  const pins = [...r.toUpperCase().matchAll(/\bP([A-K])(\d{1,2})\b/g)]
    .filter((m) => Number(m[2]) < 16)
    .map((m) => ({ port: `GPIO${m[1]}`, n: Number(m[2]), pin: `P${m[1]}${Number(m[2])}` }));
  const it: Intent = { pins };
  if (/\balternate\b|\bAF\s?\d{1,2}\b/i.test(r)) it.mode = 'af';
  else if (/\banalog\b/i.test(r)) it.mode = 'analog';
  else if (/\boutput\b/i.test(r)) it.mode = 'output';
  else if (/\binput\b/i.test(r)) it.mode = 'input';
  if (/open[- ]?drain/i.test(r)) it.otype = 1;
  else if (/push[- ]?pull/i.test(r)) it.otype = 0;
  if (/\b(no|without)\s+pull|\bfloating\b/i.test(r)) it.pull = 0;
  else if (/pull[- ]?up/i.test(r)) it.pull = 1;
  else if (/pull[- ]?down/i.test(r)) it.pull = 2;
  const af = r.match(/\bAF\s?(\d{1,2})\b/i);
  if (af) it.af = Number(af[1]);
  const baud = r.match(/(\d{1,3}(?:,\d{3})+|\d{3,7})\s*(?:baud|bps|bd)\b/i);
  if (baud) it.baud = Number(baud[1].replace(/,/g, ''));
  const clock =
    r.match(/clock(?:\s+(?:of|is|=))?\s*(\d+(?:\.\d+)?)\s*MHz/i) ??
    r.match(/(\d+(?:\.\d+)?)\s*MHz\s*(?:APB\d?|PCLK\d?|timer|bus|clock|kernel)/i) ??
    r.match(/\bat\s+(\d+(?:\.\d+)?)\s*MHz/i);
  if (clock) it.clockHz = Number(clock[1]) * 1e6;
  if (/\bpwm\b/i.test(r)) {
    for (const m of r.matchAll(/(\d+(?:\.\d+)?)\s*(MHz|kHz|Hz)\b/gi)) {
      const hz = Number(m[1]) * (m[2].toLowerCase() === 'mhz' ? 1e6 : m[2].toLowerCase() === 'khz' ? 1e3 : 1);
      if (hz !== it.clockHz) {
        it.pwmHz = hz;
        break;
      }
    }
    const duty = r.match(/(\d+(?:\.\d+)?)\s*%/);
    if (duty) it.dutyPct = Number(duty[1]);
    const ch = r.match(/\b(?:channel|ch)\s*(\d)\b/i);
    if (ch) it.channel = Number(ch[1]);
  }
  if (/\b8\s*[x×]|oversampl\w*\s+(?:by\s+)?8\b/i.test(r)) it.over8 = 1;
  else if (/\b16\s*[x×]|oversampl\w*\s+(?:by\s+)?16\b/i.test(r)) it.over8 = 0;
  if (pins.length && !it.baud && !/\bpwm\b/i.test(r)) {
    const sp = r.match(/\b(2|10|50)\s*MHz\b/i);
    if (sp) it.speedMHz = Number(sp[1]);
  }
  return it;
}

// --- Prompt context ---------------------------------------------------------------

const MAX_CONTEXT_REGISTERS = 24;

function fieldLine(device: DeviceJson, f: FieldJson): string {
  const range = f.width === 1 ? `bit ${f.lsb}` : `bits [${f.lsb + f.width - 1}:${f.lsb}]`;
  const table = f.e === undefined ? undefined : device.enums[f.e].filter((x) => x.v !== null);
  return table?.length
    ? `  ${f.name} ${range} values: ${table.map((x) => `${x.v}=${x.n}`).join(', ')}`
    : `  ${f.name} ${range} integer 0..${2 ** f.width - 1}`;
}

/**
 * The registers a request is about, with their fields and named values, for
 * the prompt. Pins (PA5) bring that pin's GPIO fields; peripheral names
 * (USART2, TIM2) bring their configuration registers; both bring the RCC
 * enable bit.
 */
export function proposalContext(device: DeviceJson, request: string): { text: string; keys: string[] } | { error: string } {
  const fam = family(device);
  const it = parseIntent(request);
  const blocks: string[] = [];
  const keys: string[] = [];
  const enables = new Set<string>();
  const add = (p: PeripheralJson, r: RegisterJson, fields: FieldJson[]) => {
    if (!fields.length || keys.length >= MAX_CONTEXT_REGISTERS) return;
    const key = `${p.name}_${r.name}`;
    if (keys.includes(key)) return;
    keys.push(key);
    blocks.push(
      `${key} (C: ${cName(p.name, r.name)}) reset ${r.reset === undefined ? 'unknown' : hex(r.reset, r.size)}${r.access ? `, ${r.access}` : ''}\n` +
        fields.map((f) => fieldLine(device, f)).join('\n'),
    );
  };
  const reg = (p: string, r: string) => lookupKey(device, `${p}_${r}`);

  for (const pin of it.pins) {
    const port = device.peripherals.find((p) => p.name === pin.port);
    if (!port) continue;
    enables.add(pin.port);
    const pick = (r: string, re: RegExp) => {
      const h = reg(pin.port, r);
      if (h) add(h.peripheral, h.register, h.register.fields.filter((f) => re.test(f.name)));
    };
    const n = pin.n;
    if (fam === 'f1') {
      pick(n < 8 ? 'CRL' : 'CRH', new RegExp(`^(MODE|CNF)${n}$`));
      pick('ODR', new RegExp(`^ODR${n}$`));
    } else {
      pick('MODER', new RegExp(`^MODER${n}$`));
      pick('OTYPER', new RegExp(`^OT${n}$`));
      pick('OSPEEDR', new RegExp(`^OSPEEDR${n}$`));
      pick('PUPDR', new RegExp(`^PUPDR${n}$`));
      pick('ODR', new RegExp(`^ODR${n}$`));
      pick(n < 8 ? 'AFRL' : 'AFRH', new RegExp(`^AFR[LH]?${n}$`));
    }
  }

  const words = new Set([...request.toUpperCase().matchAll(/\b([A-Z][A-Z0-9]*\d)\b/g)].map((m) => m[1]));
  for (const p of device.peripherals) {
    if (!words.has(p.name) || /^GPIO/.test(p.name) || p.name === 'RCC') continue;
    enables.add(p.name);
    const wanted = /^(USART|UART|LPUART)/.test(p.name)
      ? /^(CR1|CR2|CR3|BRR|PRESC)$/
      : /^TIM/.test(p.name)
        ? /^(CR1|EGR|CCMR[12]_Output|CCER|PSC|ARR|CCR[1-4]|BDTR)$/
        : /./;
    for (const r of p.registers) {
      if (!wanted.test(r.name) || r.access === 'read-only') continue;
      add(p, r, r.fields.filter((f) => f.access !== 'read-only'));
    }
  }

  for (const p of enables) {
    const en = enableBit(device, p);
    const h = en && lookupKey(device, en.register);
    if (h) {
      const f = h.register.fields.find((x) => x.name === en.field);
      if (f) {
        const key = `${h.peripheral.name}_${h.register.name}`;
        const i = keys.indexOf(key);
        if (i >= 0) blocks[i] += '\n' + fieldLine(device, f);
        else add(h.peripheral, h.register, [f]);
      }
    }
  }

  if (!keys.length) return { error: 'Name a pin (like PA5) or a peripheral on this chip (like USART2 or TIM2).' };
  return { text: blocks.join('\n\n'), keys };
}

// --- Verification -------------------------------------------------------------------

export function verifyProposal(device: DeviceJson, request: string, proposal: Proposal): Verification {
  const fam: Family = family(device);
  const checks: Check[] = [];
  const pass = (text: string) => checks.push({ status: 'pass', text });
  const fail = (text: string) => checks.push({ status: 'fail', text });
  const note = (text: string) => checks.push({ status: 'note', text });

  if (!proposal.writes.length) fail('The proposal has no register writes.');

  // 1–3: registers, fields, values, meanings.
  const writeKeys = proposal.writes.map((w) => w.register);
  const resolved: { hit: Hit; key: string; fields: { f: FieldJson; p: ProposedField }[] }[] = [];
  const seen = new Set<string>();
  let structuralOk = true;
  for (const w of proposal.writes) {
    const hit = resolveRegister(device, w.register, writeKeys);
    if (!hit) {
      fail(`${w.register} is not a register on ${device.name}.`);
      structuralOk = false;
      continue;
    }
    const key = `${hit.peripheral.name}_${hit.register.name}`;
    if (hit.register.access === 'read-only') fail(`${key} is read-only.`);
    const fields: { f: FieldJson; p: ProposedField }[] = [];
    for (const p of w.fields) {
      const f = hit.register.fields.find((x) => x.name.toUpperCase() === p.name.toUpperCase());
      if (!f) {
        fail(`${key} has no field ${p.name}.`);
        structuralOk = false;
        continue;
      }
      if (seen.has(`${key}.${f.name}`)) fail(`${key}.${f.name} is set twice.`);
      seen.add(`${key}.${f.name}`);
      if (f.access === 'read-only') fail(`${key}.${f.name} is read-only.`);
      if (p.value < 0 || p.value >= 2 ** f.width) {
        fail(`${key}.${f.name} = ${p.value} doesn't fit in ${f.width} bit${f.width > 1 ? 's' : ''}.`);
        structuralOk = false;
        continue;
      }
      const meaning = findMeaning(device, f, p.value);
      if (f.e !== undefined && !meaning) fail(`${key}.${f.name} = ${p.value} is not a value the SVD names.`);
      if (p.meaning && meaning && norm(p.meaning) !== norm(meaning.n) && norm(p.meaning) !== norm(meaning.d ?? '')) {
        fail(`${key}.${f.name} = ${p.value} is "${meaning.n}" in the SVD, but the proposal calls it "${p.meaning}".`);
      }
      fields.push({ f, p });
    }
    resolved.push({ hit, key, fields });
  }
  if (structuralOk && proposal.writes.length) {
    const n = resolved.reduce((s, r) => s + r.fields.length, 0);
    pass(`${n} field${n > 1 ? 's' : ''} in ${resolved.length} register${resolved.length > 1 ? 's' : ''} exist in the SVD and fit their bit widths.`);
  }
  const meaningFails = checks.some((c) => c.status === 'fail' && /in the SVD, but|not a value the SVD names/.test(c.text));
  if (structuralOk && !meaningFails) pass('Every named value matches the SVD, including the meanings the AI stated.');

  const fieldOf = (key: string, name: string) =>
    resolved.find((r) => r.key === key)?.fields.find((x) => x.f.name === name)?.p.value;

  // 4: does it match what was asked?
  const it = parseIntent(request);
  for (const pin of it.pins) {
    const n = pin.n;
    const expect = (key: string, field: string, want: number[], what: string) => {
      const got = fieldOf(key, field);
      if (got === undefined) fail(`The request asks for ${what} on ${pin.pin}, but the proposal doesn't set ${key}.${field}.`);
      else if (!want.includes(got)) fail(`The request asks for ${what} on ${pin.pin}, but ${key}.${field} = ${got}.`);
      else pass(`${pin.pin} ${what}: ${key}.${field} = ${got}.`);
    };
    if (fam === 'f1') {
      const cr = `${pin.port}_CR${n < 8 ? 'L' : 'H'}`;
      if (it.mode === 'output' || it.mode === 'af') {
        expect(cr, `MODE${n}`, it.speedMHz ? [{ 2: 2, 10: 1, 50: 3 }[it.speedMHz]!] : [1, 2, 3], it.speedMHz ? `an output at ${it.speedMHz} MHz` : 'an output');
        const base = it.mode === 'af' ? 2 : 0;
        expect(cr, `CNF${n}`, it.otype === undefined ? [base, base + 1] : [base + it.otype], `${it.mode === 'af' ? 'alternate-function' : 'general-purpose'}${it.otype === 1 ? ' open-drain' : it.otype === 0 ? ' push-pull' : ''}`);
      } else if (it.mode === 'input' || it.mode === 'analog') {
        expect(cr, `MODE${n}`, [0], 'input mode');
        if (it.mode === 'analog') expect(cr, `CNF${n}`, [0], 'analog');
        else if (it.pull === 0) expect(cr, `CNF${n}`, [1], 'floating input');
        else if (it.pull !== undefined) {
          expect(cr, `CNF${n}`, [2], 'pull-up/pull-down input');
          note(`On the F103 the pull direction comes from ODR${n} (1 = up, 0 = down); check it separately.`);
        }
      }
    } else {
      const modeVal = { input: 0, output: 1, af: 2, analog: 3 };
      if (it.mode) expect(`${pin.port}_MODER`, `MODER${n}`, [modeVal[it.mode]], it.mode === 'af' ? 'alternate-function mode' : `${it.mode} mode`);
      if (it.otype !== undefined) expect(`${pin.port}_OTYPER`, `OT${n}`, [it.otype], it.otype ? 'open-drain' : 'push-pull');
      if (it.pull !== undefined) expect(`${pin.port}_PUPDR`, `PUPDR${n}`, [it.pull], ['no pull', 'pull-up', 'pull-down'][it.pull]);
      if (it.af !== undefined) {
        const afReg = `${pin.port}_AFR${n < 8 ? 'L' : 'H'}`;
        const h = lookupKey(device, afReg);
        const fname = h?.register.fields.find((f) => f.name === `AFR${n < 8 ? 'L' : 'H'}${n}` || f.name === `AFR${n}`)?.name;
        if (fname) expect(afReg, fname, [it.af], `AF${it.af}`);
      }
      if (/\b(low|medium|high|very high|fast)\s+speed|\d+\s*MHz/i.test(request) && !it.baud && !it.pwmHz) {
        note('Output speed is not checked against the request: speed names and limits vary by chip and supply voltage, so compare OSPEEDR with the datasheet.');
      }
    }
  }

  // Baud at a stated clock.
  const brr = resolved.find((r) => /^(USART|UART|LPUART)\d+_BRR$/.test(r.key));
  if (it.baud && brr) {
    const p = brr.hit.peripheral.name;
    const over8 = fieldOf(`${p}_CR1`, 'OVER8') ?? it.over8 ?? 0;
    if (!it.clockHz) note(`Baud not checked: say the bus clock in the request (for example "at 50 MHz").`);
    else {
      const h7 = brr.fields.some((x) => x.f.name === 'BRR');
      const res = h7
        ? usartBaudH7(it.clockHz, fieldOf(brr.key, 'BRR') ?? 0, over8)
        : usartBaudF4(it.clockHz, fieldOf(brr.key, 'DIV_Mantissa') ?? 0, fieldOf(brr.key, 'DIV_Fraction') ?? 0, over8);
      const err = ((res.baud - it.baud) / it.baud) * 100;
      if (!Number.isFinite(err) || Math.abs(err) > 1) fail(`The proposed BRR gives ${Number.isFinite(res.baud) ? Math.round(res.baud) : 'no'} baud at ${it.clockHz / 1e6} MHz, not ${it.baud} (${Number.isFinite(err) ? err.toFixed(2) : '∞'}%).`);
      else pass(`BRR gives ${Math.round(res.baud)} baud at ${it.clockHz / 1e6} MHz (${err >= 0 ? '+' : ''}${err.toFixed(2)}% from ${it.baud}).`);
    }
  } else if (it.baud && /USART|UART/i.test(request)) {
    fail(`The request asks for ${it.baud} baud, but the proposal doesn't set BRR.`);
  }

  // PWM frequency and duty at a stated clock.
  const timer = resolved.find((r) => /^TIM\d+_/.test(r.key))?.hit.peripheral;
  if (it.pwmHz && timer) {
    const t = timer.name;
    const ch = it.channel ?? 1;
    const reset = (r: string) => lookupKey(device, `${t}_${r}`)?.register.reset ?? 0;
    const psc = fieldOf(`${t}_PSC`, 'PSC') ?? reset('PSC');
    const arr = fieldOf(`${t}_ARR`, 'ARR') ?? reset('ARR');
    const ccrKey = `${t}_CCR${ch}`;
    const ccrField = lookupKey(device, ccrKey)?.register.fields[0]?.name ?? 'CCR';
    const ccr = fieldOf(ccrKey, ccrField) ?? 0;
    const mode = fieldOf(`${t}_CCMR${ch <= 2 ? 1 : 2}_Output`, `OC${ch}M`);
    if (mode !== 6 && mode !== 7) fail(`The request asks for PWM on channel ${ch}, but ${t}_CCMR${ch <= 2 ? 1 : 2}_Output.OC${ch}M is ${mode ?? 'not set'} (PWM mode 1 = 6, mode 2 = 7).`);
    else pass(`${t} channel ${ch} is in PWM mode ${mode === 6 ? 1 : 2}.`);
    const en = fieldOf(`${t}_CCER`, `CC${ch}E`);
    if (en !== 1) fail(`Channel ${ch}'s output isn't enabled: ${t}_CCER.CC${ch}E is ${en ?? 'not set'}.`);
    if (fieldOf(`${t}_CR1`, 'CEN') !== 1) note(`${t}_CR1.CEN isn't set to 1 in the proposal; the counter must be started separately.`);
    if (!it.clockHz) note('PWM frequency not checked: say the timer clock in the request (for example "timer clock 100 MHz").');
    else {
      const r = timerPwm(it.clockHz, psc, arr, ccr, { mode2: mode === 7 });
      const ferr = ((r.freqHz - it.pwmHz) / it.pwmHz) * 100;
      if (Math.abs(ferr) > 1) fail(`PSC ${psc}, ARR ${arr} give ${r.freqHz.toFixed(2)} Hz at ${it.clockHz / 1e6} MHz, not ${it.pwmHz} Hz.`);
      else pass(`PSC ${psc}, ARR ${arr} give ${+r.freqHz.toFixed(3)} Hz at ${it.clockHz / 1e6} MHz.`);
      if (it.dutyPct !== undefined) {
        if (Math.abs(r.dutyPct - it.dutyPct) > 0.5) fail(`CCR${ch} ${ccr} gives ${r.dutyPct.toFixed(1)}% duty, not ${it.dutyPct}%.`);
        else pass(`CCR${ch} ${ccr} gives ${+r.dutyPct.toFixed(2)}% duty.`);
      }
    }
  }

  // RCC enable present?
  for (const p of new Set([...it.pins.map((x) => x.port), ...resolved.map((r) => r.hit.peripheral.name).filter((n) => n !== 'RCC')])) {
    const en = enableBit(device, p);
    if (en && fieldOf(en.register, en.field) !== 1) note(`The proposal doesn't set ${en.register}.${en.field} = 1; ${p}'s clock must be on for these writes to stick.`);
  }

  // 5: run the C lines.
  const results: WriteResult[] = [];
  const sizeOf = (key: string) => lookupKey(device, key)?.register.size ?? 32;
  const resolveC = (cn: string) => {
    const h = resolveRegister(device, cn, resolved.map((r) => r.key));
    return h ? `${h.peripheral.name}_${h.register.name}` : undefined;
  };
  const statements = splitC(proposal.c);
  if (!statements.length) fail('The proposal has no C lines.');
  else if (resolved.length) {
    let cOk = true;
    const starts = (size: number, reset: number) => [reset, 0, 2 ** size - 1, 0xa5a5a5a5 % 2 ** size];
    let written = new Set<string>();
    for (let s = 0; s < 4 && cOk; s++) {
      const env = new Map<string, number>();
      const start = new Map<string, number>();
      for (const r of resolved) {
        const v = starts(r.hit.register.size, r.hit.register.reset ?? 0)[s];
        env.set(r.key, v);
        start.set(r.key, v);
      }
      try {
        written = runC(statements, env, resolveC, sizeOf).written;
      } catch (e) {
        fail(`C lines can't be checked: ${e instanceof Error ? e.message : String(e)}.`);
        cOk = false;
        break;
      }
      for (const k of written) {
        if (!resolved.some((r) => r.key === k)) {
          fail(`The C lines write ${k}, which the proposal doesn't list.`);
          cOk = false;
        }
      }
      for (const r of resolved) {
        if (!written.has(r.key)) {
          fail(`No C line writes ${r.key}.`);
          cOk = false;
          continue;
        }
        const after = env.get(r.key)!;
        const before = start.get(r.key)!;
        for (const { f, p } of r.fields) {
          if (bits(after, f.lsb, f.width) !== p.value) {
            fail(`The C lines leave ${r.key}.${f.name} = ${bits(after, f.lsb, f.width)}, not ${p.value} (starting from ${hex(before, r.hit.register.size)}).`);
            cOk = false;
          }
        }
        if (r.hit.register.access === 'write-only') continue; // BSRR-style registers: other bits are no-ops
        const owned = new Set<number>();
        for (const { f } of r.fields) for (let b = f.lsb; b < f.lsb + f.width; b++) owned.add(b);
        for (let b = 0; b < r.hit.register.size; b++) {
          if (!owned.has(b) && bits(after, b, 1) !== bits(before, b, 1)) {
            const other = r.hit.register.fields.find((f) => b >= f.lsb && b < f.lsb + f.width);
            fail(`The C lines also change ${r.key} bit ${b}${other ? ` (${other.name})` : ''}, which the proposal doesn't list (starting from ${hex(before, r.hit.register.size)}).`);
            cOk = false;
            break;
          }
        }
      }
    }
    if (cOk) pass('The C lines set exactly these fields and nothing else, from 4 different start values (reset, all 0, all 1, 0xA5A5A5A5).');
  }

  // Decode what the registers hold after the writes, starting from reset.
  for (const r of resolved) {
    let value = r.hit.register.reset ?? 0;
    for (const { f, p } of r.fields) value += (p.value - bits(value, f.lsb, f.width)) * 2 ** f.lsb;
    results.push({
      key: r.key,
      peripheral: r.hit.peripheral,
      register: r.hit.register,
      value,
      decoded: decode(device, r.hit.peripheral, r.hit.register, value),
      fields: r.fields.map(({ f, p }) => ({ field: f, value: p.value, svdMeaning: findMeaning(device, f, p.value)?.n, claimed: p.meaning })),
    });
  }

  const verified = checks.length > 0 && !checks.some((c) => c.status === 'fail');
  return { verified, checks, results };
}

/** Failed checks, for the model's second attempt. */
export function failures(v: Verification): string[] {
  return v.checks.filter((c) => c.status === 'fail').map((c) => c.text);
}
