import { describe, expect, it } from 'vitest';
import { brrForF4, timerPwm, usartBaudF4, usartBaudH7 } from '../src/lib/doctor';
import { deriveClocks } from '../src/lib/clocks';
import { DumpView, mapDump, parseDump } from '../src/lib/dump';
import { device } from './helpers';

describe('USART baud (reference-manual formulas)', () => {
  it('F4 oversampling by 16: 84 MHz, BRR 0x2D9 -> 115,226 baud', () => {
    // USARTDIV = 45 + 9/16 = 45.5625; 84e6 / (16 * 45.5625) = 115,226
    const r = usartBaudF4(84e6, 0x2d, 9, 0);
    expect(r.usartdiv).toBe(45.5625);
    expect(Math.round(r.baud)).toBe(115226);
  });

  it('F4 oversampling by 8 uses only DIV_Fraction[2:0]', () => {
    // USARTDIV = 22 + 6/8 = 22.75; 42e6 / (8 * 22.75) = 230,769
    const r = usartBaudF4(42e6, 22, 0b1110, 1);
    expect(r.usartdiv).toBe(22.75);
    expect(Math.round(r.baud)).toBe(230769);
  });

  it('the Black Pill bug: BRR 0x8B is 115,200 at 16 MHz but 359,712 at 50 MHz', () => {
    expect(Math.round(usartBaudF4(16e6, 8, 11, 0).baud)).toBe(115108);
    expect(Math.round(usartBaudF4(50e6, 8, 11, 0).baud)).toBe(359712);
  });

  it('BRR for a target baud rounds the fraction and carries into the mantissa', () => {
    expect(brrForF4(50e6, 115200, 0)).toBe(0x1b2); // 27.127 -> 27 + 2/16
    expect(brrForF4(72e6, 115200, 0)).toBe(0x271); // 39.0625 exactly
    expect(brrForF4(16e6, 9600, 0)).toBe(0x683); // 104.1667 -> 104 + 3/16
  });

  it('H7: OVER16 baud = f / BRR; OVER8 BRR packs USARTDIV[3:0] >> 1 into BRR[2:0]', () => {
    expect(usartBaudH7(64e6, 556, 0).baud).toBeCloseTo(115107.9, 1);
    // USARTDIV 1111 = 0x457: BRR = 0x450 | (0x7 >> 1) = 0x453
    const r = usartBaudH7(64e6, 0x453, 1);
    expect(r.usartdiv).toBe(0x456);
    expect(r.baud).toBeCloseTo((2 * 64e6) / 0x456, 6);
  });
});

describe('timer PWM (reference-manual formulas)', () => {
  it('edge-aligned PWM mode 1: 100 MHz, PSC 99, ARR 999, CCR 250 -> 1 kHz, 25%', () => {
    expect(timerPwm(100e6, 99, 999, 250)).toEqual({ freqHz: 1000, dutyPct: 25 });
  });
  it('CCR above ARR is 100% duty; CCR 0 is 0%', () => {
    expect(timerPwm(1e6, 0, 99, 500).dutyPct).toBe(100);
    expect(timerPwm(1e6, 0, 99, 0).dutyPct).toBe(0);
  });
  it('PWM mode 2 inverts the duty', () => {
    expect(timerPwm(100e6, 99, 999, 250, { mode2: true }).dutyPct).toBe(75);
  });
  it('center-aligned halves the frequency: period = 2 x ARR', () => {
    const r = timerPwm(72e6, 0, 1000, 250, { cms: 1 });
    expect(r.freqHz).toBe(36000);
    expect(r.dutyPct).toBe(25);
  });
  it('downcounting PWM mode 1 is active for CCR + 1 counts', () => {
    expect(timerPwm(1e6, 0, 99, 24, { down: true }).dutyPct).toBe(25);
  });
});

describe('clock tree from RCC', () => {
  it('F411 Black Pill: HSE 25 MHz, PLLM 25, PLLN 200, PLLP 2, APB1 /2', () => {
    const d = device('stm32f411');
    const v = new DumpView(mapDump(d, parseDump('0x40023804: 0x04403219 0x0000100a')));
    const c = deriveClocks(d, v, { hseHz: 25e6 });
    expect([c.sysclk.hz, c.hclk.hz, c.pclk1.hz, c.pclk2.hz, c.tim1.hz, c.tim2.hz]).toEqual([100e6, 100e6, 50e6, 100e6, 100e6, 100e6]);
  });
  it('F103 Blue Pill: HSE 8 MHz x 9 = 72 MHz, APB1 36 MHz with 72 MHz timers', () => {
    const d = device('stm32f103');
    const c = deriveClocks(d, new DumpView(mapDump(d, parseDump('RCC_CFGR = 0x001D040A'))), { hseHz: 8e6 });
    expect([c.sysclk.hz, c.pclk1.hz, c.pclk2.hz, c.tim1.hz]).toEqual([72e6, 36e6, 72e6, 72e6]);
  });
  it('F407 on HSI after reset is 16 MHz everywhere', () => {
    const d = device('stm32f407');
    const c = deriveClocks(d, new DumpView(mapDump(d, parseDump('RCC_CFGR = 0x0'))), {});
    expect([c.sysclk.hz, c.pclk1.hz, c.tim1.hz]).toEqual([16e6, 16e6, 16e6]);
  });
  it('typed clocks win over RCC; timer clock still follows the APB prescaler', () => {
    const d = device('stm32f411');
    const v = new DumpView(mapDump(d, parseDump('0x40023804: 0x04403219 0x0000100a')));
    const c = deriveClocks(d, v, { hseHz: 25e6, apb1Hz: 42e6 });
    expect(c.pclk1).toEqual({ hz: 42e6, source: 'manual' });
    expect(c.tim1.hz).toBe(84e6);
  });
  it('without RCC_CFGR the clocks are unknown, not guessed', () => {
    const d = device('stm32f411');
    const c = deriveClocks(d, new DumpView(mapDump(d, parseDump('GPIOA_MODER = 0'))), {});
    expect(c.pclk1.source).toBe('unknown');
    expect(c.notes.join(' ')).toMatch(/No RCC_CFGR/);
  });
});
