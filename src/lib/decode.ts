// Deterministic register decoding. Pure functions, shared by the browser UI and
// the /api/explain endpoint so the AI only ever sees what this code computed.

import type { DeviceJson, EnumValue, FieldJson, PeripheralJson, RegisterJson } from './types';

export interface DecodedField {
  field: FieldJson;
  /** Field value extracted from the register value. */
  value: number;
  /** Field value at reset, when the register has a reset value. */
  resetValue?: number;
  /** Named meaning from the SVD, when one matches. */
  meaning?: EnumValue;
  /** True when the SVD names values for this field but none matches. */
  unknownValue: boolean;
  changedFromReset: boolean;
}

export interface DecodedRegister {
  peripheral: PeripheralJson;
  register: RegisterJson;
  address: number;
  value: number;
  fields: DecodedField[];
  /** Bits set in `value` that no field covers (reserved bits). */
  reservedSet: number;
}

const pow2 = (n: number) => 2 ** n;

/** Extract `width` bits starting at `lsb` without 32-bit signed pitfalls. */
export function bits(value: number, lsb: number, width: number): number {
  return Math.floor(value / pow2(lsb)) % pow2(width);
}

export function hex(value: number, sizeBits = 32): string {
  return '0x' + value.toString(16).toUpperCase().padStart(Math.ceil(sizeBits / 4), '0');
}

export function bin(value: number, width: number): string {
  return value.toString(2).padStart(width, '0');
}

export function bitRange(f: FieldJson): string {
  return f.width === 1 ? `[${f.lsb}]` : `[${f.lsb + f.width - 1}:${f.lsb}]`;
}

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Parse what someone pastes from a debugger: `0xABFFFFFF`, `ABFF_FFFF`,
 * `0b1010`, `2885681151`, GDB's `$1 = 0xabffffff`, or a signed `-1409286145`.
 */
export function parseValue(input: string, sizeBits = 32): ParseResult {
  let t = input.trim();
  if (!t) return { ok: false, error: 'Paste a value, e.g. 0xABFFFFFF' };
  // GDB / OpenOCD output: keep what follows the last '=' or ':'
  const eq = Math.max(t.lastIndexOf('='), t.lastIndexOf(':'));
  if (eq >= 0) t = t.slice(eq + 1).trim();
  t = t.split(/\s+/)[0].replace(/[_']/g, '').replace(/[uUlL]+$/, '');

  let v: number;
  if (/^-?0x[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
  else if (/^0b[01]+$/i.test(t)) v = parseInt(t.slice(2), 2);
  else if (/^-?\d+$/.test(t)) v = parseInt(t, 10);
  else if (/^[0-9a-f]+$/i.test(t)) v = parseInt(t, 16); // bare hex like ABFFFFFF
  else return { ok: false, error: `"${input.trim()}" isn't a number I can read` };

  const max = pow2(sizeBits);
  if (v < 0) {
    if (v < -max / 2) return { ok: false, error: `Out of range for a ${sizeBits}-bit register` };
    v += max; // two's complement, as GDB prints signed ints
  }
  if (!Number.isSafeInteger(v) || v >= max) {
    return { ok: false, error: `Too big for a ${sizeBits}-bit register` };
  }
  return { ok: true, value: v };
}

export function findMeaning(device: DeviceJson, f: FieldJson, value: number): EnumValue | undefined {
  if (f.e === undefined) return undefined;
  const table = device.enums[f.e];
  return table.find((x) => x.v === value) ?? table.find((x) => x.v === null);
}

export function enumTable(device: DeviceJson, f: FieldJson): EnumValue[] | undefined {
  return f.e === undefined ? undefined : device.enums[f.e];
}

export function decode(
  device: DeviceJson,
  peripheral: PeripheralJson,
  register: RegisterJson,
  value: number,
): DecodedRegister {
  let covered = 0;
  const fields = register.fields.map((f): DecodedField => {
    covered += (pow2(f.width) - 1) * pow2(f.lsb);
    const v = bits(value, f.lsb, f.width);
    const meaning = findMeaning(device, f, v);
    const resetValue = register.reset === undefined ? undefined : bits(register.reset, f.lsb, f.width);
    return {
      field: f,
      value: v,
      resetValue,
      meaning,
      unknownValue: f.e !== undefined && !meaning,
      changedFromReset: resetValue !== undefined && resetValue !== v,
    };
  });
  // Bits set that no field covers. Work bit by bit to stay out of signed-int land.
  let reservedSet = 0;
  for (let b = 0; b < register.size; b++) {
    if (bits(value, b, 1) && !bits(covered, b, 1)) reservedSet += pow2(b);
  }
  return {
    peripheral,
    register,
    address: peripheral.base + register.offset,
    value,
    fields,
    reservedSet,
  };
}

/** Find a register by "PERIPH_REG", "PERIPH->REG", "PERIPH.REG" or "PERIPH REG". */
export function lookup(
  device: DeviceJson,
  periphName: string,
  regName: string,
): { peripheral: PeripheralJson; register: RegisterJson } | undefined {
  const p = device.peripherals.find((x) => x.name === periphName);
  const r = p?.registers.find((x) => x.name === regName);
  return p && r ? { peripheral: p, register: r } : undefined;
}

/** Compact, model-friendly JSON of a decode. Only facts from the SVD and the value. */
export function decodeToFacts(device: DeviceJson, d: DecodedRegister) {
  const size = d.register.size;
  return {
    chip: device.name,
    register: `${d.peripheral.name}_${d.register.name}`,
    peripheral_description: d.peripheral.description,
    register_description: d.register.description,
    address: hex(d.address),
    value: hex(d.value, size),
    reset_value: d.register.reset === undefined ? undefined : hex(d.register.reset, size),
    reserved_bits_set: d.reservedSet ? hex(d.reservedSet, size) : undefined,
    fields: d.fields.map((f) => ({
      name: f.field.name,
      bits: bitRange(f.field),
      value: f.field.width > 1 ? `0b${bin(f.value, f.field.width)} (${f.value})` : String(f.value),
      meaning: f.meaning ? f.meaning.n : f.unknownValue ? 'value not listed in SVD' : undefined,
      meaning_detail: f.meaning?.d,
      field_description: f.field.description,
      changed_from_reset: f.changedFromReset || undefined,
    })),
  };
}
