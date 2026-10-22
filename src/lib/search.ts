// Register search: "GPIOA_MODER", "gpioa->moder", "rcc ahb1enr", "MODER", or an
// absolute address like "0x40020000".

import type { DeviceJson, PeripheralJson, RegisterJson } from './types';

export interface RegisterHit {
  key: string; // "GPIOA_MODER"
  peripheral: PeripheralJson;
  register: RegisterJson;
  address: number;
}

export function buildIndex(device: DeviceJson): RegisterHit[] {
  const out: RegisterHit[] = [];
  for (const p of device.peripherals) {
    for (const r of p.registers) {
      out.push({ key: `${p.name}_${r.name}`, peripheral: p, register: r, address: p.base + r.offset });
    }
  }
  return out;
}

export function normalizeQuery(q: string): string {
  return q
    .trim()
    .toUpperCase()
    .replace(/->|\.|::|\s+/g, '_')
    .replace(/_+/g, '_');
}

export function search(index: RegisterHit[], query: string, limit = 12): RegisterHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];

  // Absolute address lookup
  if (/^0X[0-9A-F]+$/.test(q)) {
    const addr = parseInt(q.slice(2), 16);
    return index.filter((h) => h.address === addr).slice(0, limit);
  }

  const scored: { h: RegisterHit; s: number }[] = [];
  for (const h of index) {
    const k = h.key;
    let s = -1;
    if (k === q) s = 0;
    else if (h.register.name === q) s = 1;
    else if (k.startsWith(q)) s = 2;
    else if (h.register.name.startsWith(q)) s = 3;
    else if (k.includes(q)) s = 4;
    else {
      // every query token appears somewhere in the key
      const toks = q.split('_').filter(Boolean);
      if (toks.length > 1 && toks.every((t) => k.includes(t))) s = 5;
    }
    if (s >= 0) scored.push({ h, s });
  }
  scored.sort((a, b) => a.s - b.s || a.h.key.length - b.h.key.length || a.h.key.localeCompare(b.h.key));
  return scored.slice(0, limit).map((x) => x.h);
}
