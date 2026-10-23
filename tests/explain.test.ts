import { describe, expect, it } from 'vitest';
import { decode, decodeToFacts, lookupKey } from '../src/lib/decode';
import { fallbackSummary, focusFields, groupFields, verifyReply } from '../api/explain';
import { device } from './helpers';

// Regression tests for the single-register Explain checks (unchanged behavior).
const facts = () => {
  const d = device('stm32f407');
  const h = lookupKey(d, 'GPIOA_MODER')!;
  return decodeToFacts(d, decode(d, h.peripheral, h.register, 0xabfff3ff));
};

describe('single-register Explain checks', () => {
  it('verifyReply catches a misstated field and accepts a correct one', () => {
    expect(verifyReply('MODER5 = 0b00 means Input.', facts())).toEqual([]);
    expect(verifyReply('MODER5 = 0b11 (Analog)', facts())).toEqual(['MODER5 is 0b00, not 0b11']);
  });
  it('focusFields finds the pin a question names', () => {
    expect(focusFields('PA5 LED does not toggle', facts())).toEqual(['MODER5']);
  });
  it('groups identical neighbours and builds the decoder fallback', () => {
    expect(groupFields(facts().fields).some((g) => g.length > 1)).toBe(true);
    expect(fallbackSummary(facts())).toMatch(/^GPIOA_MODER = 0xABFFF3FF/);
  });
});
