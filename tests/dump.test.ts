import { describe, expect, it } from 'vitest';
import { mapDump, normalizeName, parseDump } from '../src/lib/dump';
import { device } from './helpers';

const f411 = () => device('stm32f411');

describe('parseDump', () => {
  it('reads GDB x/Nwx rows, one word per 4 bytes', () => {
    const p = parseDump('(gdb) x/6wx 0x40020000\n0x40020000:\t0xa80000a0\t0x00000000\t0x0c0000f0\t0x64000040\n0x40020010:\t0x0000c40c\t0x00000000');
    expect(p.skipped).toEqual([]);
    expect(p.words.map((w) => w.address)).toEqual([0x40020000, 0x40020004, 0x40020008, 0x4002000c, 0x40020010, 0x40020014]);
    expect(p.words[0].value).toBe(0xa80000a0);
  });

  it('reads GDB rows with a <symbol> and OpenOCD mdw rows with bare hex', () => {
    const p = parseDump('0x40004400 <huart2>:\t0x000000c0\t0x00000000\n0x40004408: 0000008b 0000200c');
    expect(p.words.map((w) => [w.address, w.value])).toEqual([
      [0x40004400, 0xc0],
      [0x40004404, 0],
      [0x40004408, 0x8b],
      [0x4000440c, 0x200c],
    ]);
  });

  it('reads named and address lines in every common spelling', () => {
    const p = parseDump('GPIOA->MODER = 0xA80000A0\nrcc_ahb1enr: 0x1\nGPIOA.AFR[0] 0x7700\n0x40004408 = 0x8b\n*(uint32_t *)0x4000440C = 0x200c');
    expect(p.skipped).toEqual([]);
    expect(p.words).toMatchObject([
      { name: 'GPIOA_MODER', value: 0xa80000a0 },
      { name: 'RCC_AHB1ENR', value: 1 },
      { name: 'GPIOA_AFR0', value: 0x7700 },
      { address: 0x40004408, value: 0x8b },
      { address: 0x4000440c, value: 0x200c },
    ]);
  });

  it('pairs `p/x NAME` with the `$n = value` line after it', () => {
    const p = parseDump('(gdb) p/x GPIOA->ODR\n$1 = 0x20');
    expect(p.words).toMatchObject([{ name: 'GPIOA_ODR', value: 0x20 }]);
  });

  it('expands `p/x *PERIPH` struct output, including AFR arrays and pretty-printed structs', () => {
    const one = parseDump('(gdb) p/x *GPIOC\n$1 = {MODER = 0x4000000, OTYPER = 0x0, AFR = {0x0, 0x70}}');
    expect(one.words.map((w) => w.name)).toEqual(['GPIOC_MODER', 'GPIOC_OTYPER', 'GPIOC_AFR0', 'GPIOC_AFR1']);
    const pretty = parseDump('(gdb) p/x *USART2\n$2 = {\n  SR = 0xc0,\n  DR = 0x0,\n  BRR = 0x8b\n}');
    expect(pretty.words.map((w) => [w.name, w.value])).toEqual([
      ['USART2_SR', 0xc0],
      ['USART2_DR', 0],
      ['USART2_BRR', 0x8b],
    ]);
  });

  it('lists lines it cannot read, with a reason', () => {
    const p = parseDump('hello world\n$3 = 0x5');
    expect(p.skipped.map((s) => s.line)).toEqual([1, 2]);
    expect(p.skipped[1].reason).toMatch(/without a register name/);
  });

  it('normalizes C and GDB spellings', () => {
    expect(normalizeName('gpioa -> afr[1]')).toBe('GPIOA_AFR1');
    expect(normalizeName('RCC.CFGR')).toBe('RCC_CFGR');
  });
});

describe('mapDump', () => {
  it('maps each word to the register at that address and decodes it', () => {
    const m = mapDump(f411(), parseDump('0x40020000: 0xa80000a0 0x00000000\n0x40020020: 0x00007700'));
    expect(m.registers.map((r) => r.key)).toEqual(['GPIOA_MODER', 'GPIOA_OTYPER', 'GPIOA_AFRL']);
    const afrl = m.registers[2].decoded.fields.find((f) => f.field.name === 'AFRL2');
    expect(afrl?.value).toBe(7);
    expect(afrl?.meaning?.n).toBe('AF7');
  });

  it('resolves CMSIS names (AFR[0], CCMR1) and picks CCMR1_Output vs _Input by CCxS', () => {
    const m = mapDump(f411(), parseDump('GPIOA->AFR[0] = 0x7700\nTIM2->CCMR1 = 0x68\nTIM3->CCMR1 = 0x0101'));
    expect(m.registers.map((r) => r.key).sort()).toEqual(['GPIOA_AFRL', 'TIM2_CCMR1_Output', 'TIM3_CCMR1_Input']);
  });

  it('masks 16-bit registers and flags set upper bits', () => {
    const m = mapDump(f411(), parseDump('0x40004408: 0x0001008b'));
    expect(m.registers[0]).toMatchObject({ key: 'USART2_BRR', value: 0x8b, upperBits: 1 });
  });

  it('drops zero words in gaps, keeps non-zero ones, and uses the last of duplicates', () => {
    const m = mapDump(f411(), parseDump('0x40000030: 0x0 0x5\nGPIOA_ODR = 1\nGPIOA_ODR = 2\n0x40000030 = 0x9'));
    expect(m.unmapped).toEqual([{ address: 0x40000030, value: 9, line: 4 }]);
    expect(m.registers.find((r) => r.key === 'GPIOA_ODR')?.value).toBe(2);
    expect(m.notes.join(' ')).toMatch(/GPIOA_ODR appears more than once/);
    expect(m.registers.find((r) => r.key === 'TIM2_CCR1')?.value).toBe(5);
  });

  it('reports names that are not registers on the chip', () => {
    const m = mapDump(f411(), parseDump('GPIOA_NOPE = 0x1'));
    expect(m.skipped[0].reason).toMatch(/no register called GPIOA_NOPE/);
  });
});
