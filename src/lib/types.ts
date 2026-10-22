// Shared shapes for the compact device JSON produced by scripts/svd_to_json.ts
// and consumed by the browser app and the explain endpoint.

/** One named value a field can take. `v === null` marks the SVD `isDefault` entry. */
export interface EnumValue {
  v: number | null;
  n: string;
  d?: string;
}

export interface FieldJson {
  name: string;
  /** Least-significant bit position. */
  lsb: number;
  width: number;
  access?: string;
  description?: string;
  /** Index into DeviceJson.enums, when the SVD names this field's values. */
  e?: number;
}

export interface RegisterJson {
  /** Flattened name inside the peripheral, e.g. "MODER" or "ST3_CR" for clusters. */
  name: string;
  /** Byte offset from the peripheral base address. */
  offset: number;
  /** Width in bits. */
  size: number;
  access?: string;
  reset?: number;
  description?: string;
  fields: FieldJson[];
}

export interface PeripheralJson {
  name: string;
  description?: string;
  group?: string;
  base: number;
  registers: RegisterJson[];
}

export interface DeviceJson {
  id: string;
  name: string;
  description?: string;
  source: string;
  /** Shared, deduplicated enum tables referenced by FieldJson.e. */
  enums: EnumValue[][];
  peripherals: PeripheralJson[];
}

export interface ChipIndexEntry {
  id: string;
  name: string;
  label: string;
  file: string;
  peripherals: number;
  registers: number;
}
