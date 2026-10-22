// Convert CMSIS-SVD files (stm32-rs patched SVDs) into compact JSON for RegLens.
//
//   node scripts/svd_to_json.ts            # converts every data/svd/*.svd
//
// Output: public/svd/<id>.json per chip, plus public/svd/index.json.
// Handles: peripheral/cluster/register/field `derivedFrom`, `dim` arrays on
// clusters, registers and fields, enumeratedValues `derivedFrom` (by name or
// dotted path), inherited size/access/reset, and enum-table deduplication.
// Runs on Node 22.6+/24 with native TypeScript type stripping.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type {
  ChipIndexEntry,
  DeviceJson,
  EnumValue,
  FieldJson,
  PeripheralJson,
  RegisterJson,
} from '../src/lib/types.ts';

// ---------- raw XML shapes (only what we read) ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped XML tree from fast-xml-parser
type Raw = Record<string, any>;

const ARRAY_TAGS = new Set([
  'peripheral',
  'register',
  'cluster',
  'field',
  'enumeratedValues',
  'enumeratedValue',
  'interrupt',
  'addressBlock',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

// ---------- helpers ----------
const LABELS: Record<string, string> = {
  stm32f103: 'STM32F103 (Blue Pill)',
  stm32f407: 'STM32F407 (Discovery)',
  stm32f411: 'STM32F411 (Black Pill)',
  stm32h743: 'STM32H743 (Nucleo-H743ZI)',
};

function clean(s: unknown): string | undefined {
  if (s === undefined || s === null) return undefined;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length ? t : undefined;
}

/** SVD scaledNonNegativeInteger: 0x.., #binary, decimal, optional k/M/G suffix. */
function num(s: unknown): number | undefined {
  if (s === undefined || s === null) return undefined;
  let t = String(s).trim();
  if (!t) return undefined;
  let scale = 1;
  const suffix = t.at(-1)!.toLowerCase();
  if (!/^0x/i.test(t) && (suffix === 'k' || suffix === 'm' || suffix === 'g')) {
    scale = suffix === 'k' ? 1024 : suffix === 'm' ? 1024 ** 2 : 1024 ** 3;
    t = t.slice(0, -1);
  }
  let v: number;
  if (/^0x/i.test(t)) v = parseInt(t.slice(2), 16);
  else if (t.startsWith('#')) {
    if (/x/i.test(t)) return undefined; // don't-care bits: not representable as one value
    v = parseInt(t.slice(1), 2);
  } else if (/^0b/i.test(t)) v = parseInt(t.slice(2), 2);
  else v = parseInt(t, 10);
  return Number.isFinite(v) ? v * scale : undefined;
}

function clone<T>(x: T): T {
  return structuredClone(x);
}

/** Expand a dimIndex spec ("0-15", "A,B,C", "1-2") into dim strings. */
function dimIndices(el: Raw): string[] | null {
  const dim = num(el.dim);
  if (!dim) return null;
  const spec = clean(el.dimIndex);
  if (!spec) return Array.from({ length: dim }, (_, i) => String(i));
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  }
  const alpha = /^([A-Z])-([A-Z])$/.exec(spec);
  if (alpha) {
    const a = alpha[1].charCodeAt(0);
    const b = alpha[2].charCodeAt(0);
    return Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i));
  }
  return spec.split(',').map((s) => s.trim());
}

/** Substitute %s / [%s] in a name or description. */
function sub(s: string | undefined, idx: string): string | undefined {
  if (s === undefined) return undefined;
  return s.replace(/\[%s\]/g, idx).replace(/%s/g, idx);
}

/** Expand a possibly-dim element into concrete instances with their offset step. */
function expand(el: Raw): { el: Raw; idx: string | null; step: number; i: number }[] {
  const idxs = dimIndices(el);
  if (!idxs) return [{ el, idx: null, step: 0, i: 0 }];
  const inc = num(el.dimIncrement) ?? 0;
  return idxs.map((idx, i) => ({ el, idx, step: inc, i }));
}

/** Merge a derived element onto its base: own keys win, missing keys inherit. */
function mergeDerived(base: Raw, own: Raw): Raw {
  const out = clone(base);
  for (const [k, v] of Object.entries(own)) {
    if (k === '@_derivedFrom') continue;
    out[k] = v;
  }
  // A derived element that re-declares nothing about dims should not inherit
  // the base's dim block unless it also inherits the templated name.
  if (own.name !== undefined && !String(own.name).includes('%s')) {
    delete out.dim;
    delete out.dimIndex;
    delete out.dimIncrement;
  }
  return out;
}

function lookupByName(list: Raw[] | undefined, name: string): Raw | undefined {
  return list?.find((x) => x.name === name);
}

// ---------- intermediate model for enum resolution ----------
interface PendingField {
  periph: string;
  reg: string;
  out: FieldJson;
  blocks: Raw[]; // raw enumeratedValues blocks (some may be derivedFrom)
}

interface EnumHome {
  periph: string;
  reg: string;
  field: string;
  enumName?: string;
  block: Raw;
}

interface Ctx {
  periph: string;
  size?: number;
  access?: string;
  reset?: number;
}

function convertDevice(id: string, xml: string): { device: DeviceJson; stats: string } {
  const doc = parser.parse(xml);
  const dev: Raw = doc.device;
  const rawPeriphs: Raw[] = dev.peripherals.peripheral;

  // 1. Resolve peripheral derivedFrom.
  const byName = new Map<string, Raw>(rawPeriphs.map((p) => [p.name, p]));
  const resolvedPeriph = new Map<string, Raw>();
  const resolveP = (p: Raw, depth = 0): Raw => {
    if (resolvedPeriph.has(p.name)) return resolvedPeriph.get(p.name)!;
    let out = p;
    const from = p['@_derivedFrom'];
    if (from && depth < 8) {
      const base = byName.get(from);
      if (base) {
        out = mergeDerived(resolveP(base, depth + 1), p);
        if (!p.registers) out.registers = clone(resolveP(base, depth + 1).registers);
      }
    }
    resolvedPeriph.set(p.name, out);
    return out;
  };

  const pending: PendingField[] = [];
  const enumHomes: EnumHome[] = [];
  const peripherals: PeripheralJson[] = [];
  const unresolved: string[] = [];

  /** Find a register by bare name in the enclosing scopes, or by a dotted
   *  path PERIPH.[CLUSTER.]*REG / [CLUSTER.]*REG through clusters. */
  const findIn = (container: Raw | undefined, parts: string[]): Raw | undefined => {
    let cur = container;
    for (let i = 0; cur && i < parts.length - 1; i++) {
      cur = (cur.cluster as Raw[] | undefined)?.find((c) => c.name === parts[i]);
    }
    return lookupByName(cur?.register, parts.at(-1)!);
  };
  const resolveRegPath = (ref: string, scopes: Raw[]): Raw | undefined => {
    const parts = ref.split('.');
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = findIn(scopes[i], parts);
      if (hit) return hit;
    }
    const bp = byName.get(parts[0]);
    if (bp && parts.length > 1) return findIn(resolveP(bp).registers, parts.slice(1));
    return undefined;
  };

  const devCtx = {
    size: num(dev.size) ?? 32,
    access: clean(dev.access),
    reset: num(dev.resetValue),
  };

  for (const rp of rawPeriphs) {
    const p = resolveP(rp);
    const ctx: Ctx = {
      periph: p.name,
      size: num(p.size) ?? devCtx.size,
      access: clean(p.access) ?? devCtx.access,
      reset: num(p.resetValue) ?? devCtx.reset,
    };
    const registers: RegisterJson[] = [];

    const walk = (container: Raw, prefix: string, baseOffset: number, c: Ctx, scopes: Raw[]) => {
      const regs: Raw[] = container.register ?? [];
      const inner = [...scopes, container];
      const clusters: Raw[] = container.cluster ?? [];

      for (const rawC of clusters) {
        let cl = rawC;
        if (cl['@_derivedFrom']) {
          const base = lookupByName(clusters, cl['@_derivedFrom']);
          if (base) cl = mergeDerived(base, cl);
        }
        const cctx: Ctx = {
          periph: c.periph,
          size: num(cl.size) ?? c.size,
          access: clean(cl.access) ?? c.access,
          reset: num(cl.resetValue) ?? c.reset,
        };
        for (const inst of expand(cl)) {
          const name = inst.idx !== null ? sub(cl.name, inst.idx)! : cl.name;
          const off = baseOffset + (num(cl.addressOffset) ?? 0) + inst.step * inst.i;
          walk(cl, `${prefix}${name}_`, off, cctx, inner);
        }
      }

      for (const rawR of regs) {
        let r = rawR;
        if (r['@_derivedFrom']) {
          const ref: string = r['@_derivedFrom'];
          const base = resolveRegPath(ref, inner);
          if (base) r = mergeDerived(base, r);
          else unresolved.push(`${p.name}.${prefix}${r.name} -> register ${ref}`);
        }
        const size = num(r.size) ?? c.size ?? 32;
        const access = clean(r.access) ?? c.access;
        const reset = num(r.resetValue) ?? c.reset;

        for (const inst of expand(r)) {
          const regName = `${prefix}${inst.idx !== null ? sub(r.name, inst.idx) : r.name}`;
          const offset = baseOffset + (num(r.addressOffset) ?? 0) + inst.step * inst.i;
          const fields: FieldJson[] = [];
          const rawFields: Raw[] = r.fields?.field ?? [];

          for (const rawF of rawFields) {
            let f = rawF;
            if (f['@_derivedFrom']) {
              const ref: string = f['@_derivedFrom'];
              let base = lookupByName(rawFields, ref);
              if (!base && ref.includes('.')) {
                const parts = ref.split('.');
                const br = resolveRegPath(parts.slice(0, -1).join('.'), inner);
                base = lookupByName(br?.fields?.field, parts.at(-1)!);
              }
              if (base) f = mergeDerived(base, f);
              else unresolved.push(`${p.name}.${regName}.${f.name} -> field ${ref}`);
            }

            // Bit position: bitOffset/bitWidth, lsb/msb, or bitRange "[msb:lsb]".
            let lsb = num(f.bitOffset);
            let width = num(f.bitWidth);
            if (lsb === undefined && f.lsb !== undefined) {
              lsb = num(f.lsb)!;
              width = num(f.msb)! - lsb + 1;
            }
            if (lsb === undefined && f.bitRange) {
              const m = /\[(\d+):(\d+)\]/.exec(String(f.bitRange));
              if (m) {
                lsb = Number(m[2]);
                width = Number(m[1]) - lsb + 1;
              }
            }
            if (lsb === undefined) continue;
            width = width ?? 1;

            for (const fi of expand(f)) {
              const name = fi.idx !== null ? sub(f.name, fi.idx)! : f.name;
              const desc = clean(fi.idx !== null ? sub(f.description, fi.idx) : f.description);
              const field: FieldJson = {
                name,
                lsb: lsb + fi.step * fi.i,
                width,
              };
              const fAccess = clean(f.access);
              if (fAccess && fAccess !== access) field.access = fAccess;
              if (desc) field.description = desc;
              fields.push(field);

              const blocks: Raw[] = f.enumeratedValues ?? [];
              if (blocks.length) {
                pending.push({ periph: p.name, reg: regName, out: field, blocks });
                for (const b of blocks) {
                  if (b.enumeratedValue) {
                    enumHomes.push({
                      periph: p.name,
                      reg: regName,
                      field: name,
                      enumName: clean(b.name),
                      block: b,
                    });
                  }
                }
              }
            }
          }

          fields.sort((a, b) => b.lsb - a.lsb);
          const reg: RegisterJson = { name: regName, offset, size, fields };
          if (access) reg.access = access;
          if (reset !== undefined) reg.reset = reset;
          const desc = clean(inst.idx !== null ? sub(r.description, inst.idx) : r.description);
          if (desc) reg.description = desc;
          registers.push(reg);
        }
      }
    };

    if (p.registers) walk(p.registers, '', 0, ctx, []);
    registers.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name));

    const pj: PeripheralJson = {
      name: p.name,
      base: num(p.baseAddress) ?? 0,
      registers,
    };
    const pd = clean(p.description);
    if (pd) pj.description = pd;
    const g = clean(p.groupName);
    if (g) pj.group = g;
    peripherals.push(pj);
  }

  // 2. Resolve enumeratedValues (including derivedFrom) and dedupe tables.
  const resolveBlock = (pf: PendingField, ref: string): Raw | undefined => {
    if (ref.includes('.')) {
      const parts = ref.split('.');
      const last = parts.at(-1)!;
      const hits = enumHomes.filter((h) => h.enumName === last || h.field === last);
      const match = hits.find((h) => {
        if (parts.length >= 3) return h.periph === parts[0] && h.reg === parts[1];
        return h.reg === parts[0] || h.periph === parts[0];
      });
      return (match ?? hits[0])?.block;
    }
    const byEnum = enumHomes.filter((h) => h.enumName === ref);
    const pick = (hs: EnumHome[]) =>
      hs.find((h) => h.periph === pf.periph && h.reg === pf.reg) ??
      hs.find((h) => h.periph === pf.periph) ??
      hs[0];
    return (pick(byEnum) ?? pick(enumHomes.filter((h) => h.field === ref)))?.block;
  };

  const tables: EnumValue[][] = [];
  const tableKey = new Map<string, number>();
  let unresolvedEnum = 0;

  for (const pf of pending) {
    // Prefer the block that describes values as read (the user pasted a read value).
    const usage = (b: Raw) => clean(b.usage) ?? 'read-write';
    const ordered = [...pf.blocks].sort((a, b) => {
      const rank = (u: string) => (u === 'read' ? 0 : u === 'read-write' ? 1 : 2);
      return rank(usage(a)) - rank(usage(b));
    });
    let block = ordered[0];
    for (let depth = 0; block && block['@_derivedFrom'] && depth < 8; depth++) {
      const next = resolveBlock(pf, block['@_derivedFrom']);
      if (!next) {
        unresolvedEnum++;
        block = undefined as unknown as Raw;
        break;
      }
      block = next;
    }
    if (!block?.enumeratedValue) continue;

    const values: EnumValue[] = [];
    for (const ev of block.enumeratedValue as Raw[]) {
      const isDefault = String(ev.isDefault ?? '').trim() === 'true';
      const v = isDefault ? null : num(ev.value);
      if (v === undefined) continue;
      const item: EnumValue = { v, n: clean(ev.name) ?? '?' };
      const d = clean(ev.description);
      if (d && d !== item.n) item.d = d;
      values.push(item);
    }
    if (!values.length) continue;
    const key = JSON.stringify(values);
    let idx = tableKey.get(key);
    if (idx === undefined) {
      idx = tables.length;
      tables.push(values);
      tableKey.set(key, idx);
    }
    pf.out.e = idx;
  }

  const device: DeviceJson = {
    id,
    name: clean(dev.name) ?? id.toUpperCase(),
    source: 'stm32-rs patched SVD (https://github.com/stm32-rs/stm32-rs), based on ST CMSIS-SVD',
    enums: tables,
    peripherals,
  };
  const dd = clean(dev.description);
  if (dd) device.description = dd;

  const regCount = peripherals.reduce((n, p) => n + p.registers.length, 0);
  const enumFields = pending.filter((p) => p.out.e !== undefined).length;
  const stats =
    `${peripherals.length} peripherals, ${regCount} registers, ${tables.length} enum tables, ` +
    `${enumFields}/${pending.length} enum fields resolved; unresolved refs=${unresolved.length} enum=${unresolvedEnum}` +
    (unresolved.length ? `\n    ` + unresolved.slice(0, 12).join('\n    ') : '');
  return { device, stats };
}

// ---------- main ----------
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const inDir = path.join(root, 'data', 'svd');
const outDir = path.join(root, 'public', 'svd');
mkdirSync(outDir, { recursive: true });

const index: ChipIndexEntry[] = [];
for (const file of readdirSync(inDir).filter((f) => f.endsWith('.svd')).sort()) {
  const id = path.basename(file, '.svd').toLowerCase();
  const { device, stats } = convertDevice(id, readFileSync(path.join(inDir, file), 'utf8'));
  const json = JSON.stringify(device);
  writeFileSync(path.join(outDir, `${id}.json`), json);
  index.push({
    id,
    name: device.name,
    label: LABELS[id] ?? device.name,
    file: `svd/${id}.json`,
    peripherals: device.peripherals.length,
    registers: device.peripherals.reduce((n, p) => n + p.registers.length, 0),
  });
  console.log(`${id}: ${stats}; ${(json.length / 1024).toFixed(0)} KiB`);
}
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
console.log(`wrote ${index.length} chips to ${path.relative(root, outDir)}/`);
