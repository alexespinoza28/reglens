// Multi-register input for the peripheral doctor. Reads what a debugger prints
// and maps every word to the register the SVD places at that address.
//
// Accepted, mixed freely in one paste:
//   GDB:      0x40020000:  0xa80000a0  0x00000000 ...   (x/Nwx, with or without <symbol>)
//   OpenOCD:  0x40020000: a80000a0 00000000 ...         (mdw)
//   Named:    GPIOA->MODER = 0xA80000A0 | GPIOA_MODER: 0x... | rcc.cfgr 0x...
//   Address:  0x40020000 = 0xA80000A0 | *(uint32_t *)0x40020000 = ...
//   GDB p:    (gdb) p/x GPIOA->MODER   then   $1 = 0xa80000a0
//   GDB p *:  (gdb) p/x *GPIOA         then   $2 = {MODER = 0xa80000a0, ..., AFR = {0x0, 0x7700}}

import { bits, decode, lookupKey, parseValue } from './decode.js';
import type { DecodedRegister } from './decode.js';
import type { DeviceJson, PeripheralJson, RegisterJson } from './types.js';

export interface DumpWord {
  /** 1-based line number in the pasted text. */
  line: number;
  address?: number;
  /** Register key as typed, normalized to PERIPH_REG (e.g. GPIOA_AFR0). */
  name?: string;
  value: number;
}

export interface SkippedLine {
  line: number;
  text: string;
  reason: string;
}

export interface ParsedDump {
  words: DumpWord[];
  skipped: SkippedLine[];
}

const HEX_WORD = /^(?:0x)?[0-9a-f]{1,8}$/i;
const ADDR_ROW = /^(0x[0-9a-f]+)\s*(?:<[^>]*>)?\s*:\s*(.*)$/i;
const ADDR_ASSIGN = /^\*?\s*(?:\(\s*(?:volatile\s+)?(?:u?int32_t|unsigned(?:\s+int)?)\s*\*\s*\)\s*)?(0x[0-9a-f]+)\s*[=:]\s*(.+)$/i;
const NAMED = /^([A-Za-z_]\w*(?:\s*(?:->|\.|::)\s*[A-Za-z_]\w*(?:\[\d+\])?|_[A-Za-z_]\w*)+)\s*(?:=|:|\s)\s*(.+)$/;
const COMMAND = /^(?:x\/|p\b|p\/|print\b|print\/|output\b|info\b|mdw\b|mdh\b|monitor\b|mon\b|set\b|display\b|continue\b|c$|target\b|load\b|break\b|b\b|run\b|r$|bt\b|frame\b)/i;
const PRINT_CMD = /^(?:p|print|output)(?:\/\w+)?\s+(\*?)\s*(?:\(\s*\w+\s*\*?\s*\))?\s*([A-Za-z_][\w]*(?:\s*(?:->|\.)\s*[A-Za-z_]\w*(?:\[\d+\])?)*)\s*$/i;

/** "gpioa->moder" -> "GPIOA_MODER"; "GPIOA->AFR[1]" -> "GPIOA_AFR1". */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/\[(\d+)\]/g, '$1')
    .replace(/\s*(->|\.|::)\s*/g, '_')
    .replace(/_+/g, '_');
}

function parseWord(token: string): number | undefined {
  const t = token.replace(/[,;]$/, '');
  if (!HEX_WORD.test(t)) return undefined;
  return parseInt(t.replace(/^0x/i, ''), 16);
}

/** Split a GDB struct body "{A = 0x1, B = {0x2, 0x3}}" into name/value pairs. */
function parseStruct(body: string): { name: string; value: string }[] | undefined {
  const s = body.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return undefined;
  const inner = s.slice(1, -1);
  const out: { name: string; value: string }[] = [];
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i <= inner.length; i++) {
    const c = inner[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if ((c === ',' && depth === 0) || i === inner.length) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  for (const p of parts) {
    const m = p.trim().match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/s);
    if (!m) continue;
    const v = m[2].trim();
    if (v.startsWith('{')) {
      // Arrays: AFR = {0x0, 0x7700} -> AFR0, AFR1. Nested structs are skipped.
      const items = v.slice(1, -1).split(',').map((x) => x.trim());
      items.forEach((item, i) => {
        if (!item.includes('=')) out.push({ name: `${m[1]}${i}`, value: item });
      });
    } else {
      out.push({ name: m[1], value: v });
    }
  }
  return out;
}

export function parseDump(text: string): ParsedDump {
  const words: DumpWord[] = [];
  const skipped: SkippedLine[] = [];
  const lines = text.split(/\r?\n/);
  let pending: { name: string; deref: boolean } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const t = lines[i].trim().replace(/^\(gdb\)\s*/, '').replace(/^>\s*/, '');
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;

    if (COMMAND.test(t) && !ADDR_ROW.test(t)) {
      const pm = t.match(PRINT_CMD);
      pending = pm ? { name: pm[2], deref: pm[1] === '*' } : undefined;
      continue;
    }

    // GDB value history: $1 = ... ; may span lines with `set print pretty on`.
    const hist = t.match(/^\$\d+\s*=\s*(.*)$/s);
    if (hist) {
      let body = hist[1].trim();
      if (body.startsWith('{')) {
        const depth = (s: string) => (s.match(/\{/g)?.length ?? 0) - (s.match(/\}/g)?.length ?? 0);
        while (depth(body) > 0 && i + 1 < lines.length) body += ' ' + lines[++i].trim();
        const fields = parseStruct(body);
        if (!pending || !fields) {
          skipped.push({ line: lineNo, text: t, reason: 'struct print without a `p/x *PERIPH` line before it' });
        } else {
          const periph = normalizeName(pending.name);
          for (const f of fields) {
            const v = parseValue(f.value, 32);
            if (v.ok) words.push({ line: lineNo, name: `${periph}_${f.name.toUpperCase()}`, value: v.value });
          }
        }
      } else if (pending && !pending.deref) {
        const v = parseValue(body, 32);
        if (v.ok) words.push({ line: lineNo, name: normalizeName(pending.name), value: v.value });
        else skipped.push({ line: lineNo, text: t, reason: v.error });
      } else {
        skipped.push({ line: lineNo, text: t, reason: 'value without a register name (add the `p/x GPIOA->MODER` line above it)' });
      }
      pending = undefined;
      continue;
    }

    const row = t.match(ADDR_ROW);
    if (row) {
      const base = parseInt(row[1].slice(2), 16);
      const tokens = row[2].trim().split(/\s+/).filter(Boolean);
      let n = 0;
      for (const tok of tokens) {
        const w = parseWord(tok);
        if (w === undefined) break;
        words.push({ line: lineNo, address: base + 4 * n, value: w });
        n++;
      }
      if (!n) skipped.push({ line: lineNo, text: t, reason: 'address with no hex words after it' });
      continue;
    }

    const aa = t.match(ADDR_ASSIGN);
    if (aa) {
      const v = parseValue(aa[2], 32);
      if (v.ok) words.push({ line: lineNo, address: parseInt(aa[1].slice(2), 16), value: v.value });
      else skipped.push({ line: lineNo, text: t, reason: v.error });
      continue;
    }

    const named = t.match(NAMED);
    if (named) {
      const v = parseValue(named[2].replace(/\s*(\/\/|#).*$/, ''), 32);
      if (v.ok) words.push({ line: lineNo, name: normalizeName(named[1]), value: v.value });
      else skipped.push({ line: lineNo, text: t, reason: v.error });
      continue;
    }

    skipped.push({ line: lineNo, text: t, reason: 'not a register value' });
  }
  return { words, skipped };
}

// ---------------------------------------------------------------------------

export interface MappedRegister {
  /** PERIPH_REG */
  key: string;
  peripheral: PeripheralJson;
  register: RegisterJson;
  address: number;
  /** Value masked to the register's size. */
  value: number;
  decoded: DecodedRegister;
  line: number;
  /** Bits above a 16-bit register's width that were set in the 32-bit word. */
  upperBits?: number;
}

export interface MappedDump {
  registers: MappedRegister[];
  /** Nonzero words at addresses with no register. Zero words in gaps are expected and dropped. */
  unmapped: { address: number; value: number; line: number }[];
  skipped: SkippedLine[];
  notes: string[];
  wordCount: number;
}

type Hit = { peripheral: PeripheralJson; register: RegisterJson };
const addressIndexCache = new WeakMap<DeviceJson, Map<number, Hit[]>>();

export function addressIndex(device: DeviceJson): Map<number, Hit[]> {
  let idx = addressIndexCache.get(device);
  if (!idx) {
    idx = new Map();
    for (const p of device.peripherals) {
      for (const r of p.registers) {
        const a = p.base + r.offset;
        const list = idx.get(a) ?? [];
        list.push({ peripheral: p, register: r });
        idx.set(a, list);
      }
    }
    addressIndexCache.set(device, idx);
  }
  return idx;
}

/**
 * Several registers can share an address: timers have CCMR1_Output and
 * CCMR1_Input. Choose by the CCxS bits (00 = output on both channels).
 */
function choose(hits: Hit[], value: number): Hit {
  const out = hits.find((h) => /_Output$/.test(h.register.name));
  const inp = hits.find((h) => /_Input$/.test(h.register.name));
  if (out && inp) {
    const ccs = out.register.fields.filter((f) => /^CC\dS$/.test(f.name));
    const anyOutput = ccs.some((f) => bits(value, f.lsb, f.width) === 0);
    return anyOutput || !ccs.length ? out : inp;
  }
  return hits[0];
}

/** Resolve a typed name, including CMSIS spellings: AFR[0] -> AFRL, CCMR1 -> CCMR1_Output/Input. */
const upperIndexCache = new WeakMap<DeviceJson, Map<string, Hit>>();

/** Case-insensitive PERIPH_REG lookup: typed names are upper-cased, SVD names like CCMR1_Output are not. */
function lookupUpper(device: DeviceJson, key: string): Hit | undefined {
  let idx = upperIndexCache.get(device);
  if (!idx) {
    idx = new Map();
    for (const p of device.peripherals) for (const r of p.registers) idx.set(`${p.name}_${r.name}`.toUpperCase(), { peripheral: p, register: r });
    upperIndexCache.set(device, idx);
  }
  return idx.get(key.toUpperCase());
}

export function resolveName(device: DeviceJson, key: string, value: number): Hit | undefined {
  const direct = lookupKey(device, key) ?? lookupUpper(device, key);
  if (direct) return direct;
  const aliases: string[] = [];
  const afr = key.match(/^(.*_AFR)([01])$/);
  if (afr) aliases.push(`${afr[1]}${afr[2] === '0' ? 'L' : 'H'}`);
  const ccmr = key.match(/^(.*_CCMR\d)$/);
  if (ccmr) {
    const hits = [`${ccmr[1]}_Output`, `${ccmr[1]}_Input`]
      .map((k) => lookupUpper(device, k))
      .filter((h): h is Hit => !!h);
    if (hits.length) return choose(hits, value);
  }
  for (const a of aliases) {
    const h = lookupUpper(device, a);
    if (h) return h;
  }
  return undefined;
}

export function mapDump(device: DeviceJson, parsed: ParsedDump): MappedDump {
  const idx = addressIndex(device);
  const byKey = new Map<string, MappedRegister>();
  const unmapped: MappedDump['unmapped'] = [];
  const skipped = [...parsed.skipped];
  const notes: string[] = [];

  for (const w of parsed.words) {
    let hit: Hit | undefined;
    if (w.address !== undefined) {
      const hits = idx.get(w.address);
      if (!hits) {
        if (w.value !== 0) unmapped.push({ address: w.address, value: w.value, line: w.line });
        continue;
      }
      hit = choose(hits, w.value);
    } else if (w.name) {
      hit = resolveName(device, w.name, w.value);
      if (!hit && /RESERVED/.test(w.name)) continue; // CMSIS struct padding
      if (!hit) {
        skipped.push({ line: w.line, text: w.name, reason: `no register called ${w.name} on ${device.name}` });
        continue;
      }
    }
    if (!hit) continue;
    const size = hit.register.size;
    const max = 2 ** size;
    const value = w.value % max;
    const upper = Math.floor(w.value / max);
    const key = `${hit.peripheral.name}_${hit.register.name}`;
    if (byKey.has(key)) notes.push(`${key} appears more than once; using the value on line ${w.line}.`);
    byKey.set(key, {
      key,
      peripheral: hit.peripheral,
      register: hit.register,
      address: hit.peripheral.base + hit.register.offset,
      value,
      decoded: decode(device, hit.peripheral, hit.register, value),
      line: w.line,
      upperBits: upper ? upper : undefined,
    });
  }
  const registers = [...byKey.values()].sort((a, b) => a.address - b.address);
  return { registers, unmapped, skipped, notes, wordCount: parsed.words.length };
}

/** Convenience lookups over a mapped dump. */
export class DumpView {
  readonly dump: MappedDump;
  readonly byKey: Map<string, MappedRegister>;
  readonly peripherals: Set<string>;
  constructor(dump: MappedDump) {
    this.dump = dump;
    this.byKey = new Map(dump.registers.map((r) => [r.key, r]));
    this.peripherals = new Set(dump.registers.map((r) => r.peripheral.name));
  }
  reg(key: string): MappedRegister | undefined {
    return this.byKey.get(key);
  }
  /** Field value, or undefined when the register or field isn't in the dump. */
  field(key: string, name: string): number | undefined {
    const r = this.byKey.get(key);
    const f = r?.decoded.fields.find((x) => x.field.name === name);
    return f?.value;
  }
  has(key: string): boolean {
    return this.byKey.has(key);
  }
  ofPeripheral(name: string): MappedRegister[] {
    return this.dump.registers.filter((r) => r.peripheral.name === name);
  }
}
