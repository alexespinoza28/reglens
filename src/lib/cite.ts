// A citation: one decoded field, exactly as the decoder produced it. Findings,
// computed quantities and the clock tree all point at their evidence this way.

import { bin } from './decode.js';
import type { MappedRegister } from './dump.js';

export interface Cite {
  /** PERIPH_REG */
  register: string;
  field: string;
  value: number;
  width: number;
  /** Named value from the SVD, when there is one. */
  meaning?: string;
}

export function cite(reg: MappedRegister, field: string): Cite | undefined {
  const f = reg.decoded.fields.find((x) => x.field.name === field);
  if (!f) return undefined;
  return { register: reg.key, field, value: f.value, width: f.field.width, meaning: f.meaning?.n };
}

/**
 * "GPIOA_AFRL.AFRL2 = 0b0111 (AF7)" for fields with named values (binary, like the
 * reference manual), "USART2_BRR.DIV_Fraction = 11" for plain numbers (decimal).
 */
export function citeText(c: Cite): string {
  const v = c.meaning !== undefined && c.width > 1 ? `0b${bin(c.value, c.width)}` : String(c.value);
  return `${c.register}.${c.field} = ${v}${c.meaning ? ` (${c.meaning})` : ''}`;
}
