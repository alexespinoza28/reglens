import { describe, expect, it } from 'vitest';
import { DEFAULT_HSE } from '../src/lib/clocks';
import { diagnose, findingsSummary, verifyDoctorReply, type DoctorOptions } from '../src/lib/doctor';
import { mapDump, parseDump } from '../src/lib/dump';
import { DOCTOR_EXAMPLES } from '../src/lib/examples';
import { device } from './helpers';

function run(chip: string, dump: string, o: DoctorOptions = {}) {
  const d = device(chip);
  const m = mapDump(d, parseDump(dump));
  return { m, dx: diagnose(d, m, { hseHz: DEFAULT_HSE[chip], ...o }) };
}
const rules = (dx: ReturnType<typeof run>['dx']) => dx.findings.map((f) => f.rule);
const cites = (f: { cites: { register: string; field: string; value: number }[] }) => f.cites.map((c) => `${c.register}.${c.field}=${c.value}`);

// Black Pill RCC: HSE 25 MHz -> 100 MHz, APB1 50 MHz.
const RCC_F411 = '0x40023804: 0x04403219 0x0000100a\n';

describe('rule: clock-off', () => {
  it('flags a port whose RCC enable bit is 0 and explains the all-zero reads', () => {
    const { dx } = run('stm32f411', 'RCC_AHB1ENR = 0x1\nGPIOC_MODER = 0\nGPIOC_ODR = 0');
    const f = dx.findings.find((x) => x.rule === 'clock-off')!;
    expect(f.title).toBe('GPIOC clock is off');
    expect(cites(f)).toEqual(['RCC_AHB1ENR.GPIOCEN=0']);
    expect(f.detail).toMatch(/reads 0x00000000/);
  });
  it('uses the F103 IOPxEN bit and the H743 AHB4ENR bit', () => {
    expect(cites(run('stm32f103', 'RCC_APB2ENR = 0\nGPIOA_CRL = 0x44444443').dx.findings[0])).toEqual(['RCC_APB2ENR.IOPAEN=0']);
    expect(cites(run('stm32h743', 'RCC_AHB4ENR = 0\nGPIOB_MODER = 0').dx.findings[0])).toEqual(['RCC_AHB4ENR.GPIOBEN=0']);
  });
  it('stays quiet when the clock is on, and hints when RCC is missing', () => {
    expect(rules(run('stm32f411', 'RCC_AHB1ENR = 0x1\nGPIOA_MODER = 0xA8000000').dx)).not.toContain('clock-off');
    const { dx } = run('stm32f411', 'USART2_CR1 = 0x200c');
    expect(dx.hints.join(' ')).toMatch(/RCC_APB1ENR \(x\/1wx 0x40023840\)/);
  });
});

describe('rule: pin-mux', () => {
  it('F411: PA0 on AF2 (TIM5_CH1) while TIM2_CH1 needs AF1', () => {
    const { dx } = run('stm32f411', 'TIM2_CCER = 0x1\nTIM2_CCMR1_Output = 0x68\nGPIOA_MODER = 0xA8000002\nGPIOA_AFRL = 0x2');
    const f = dx.findings.find((x) => x.rule === 'pin-mux')!;
    expect(f.title).toBe('PA0 selects AF2, not TIM2_CH1');
    expect(f.detail).toMatch(/selects TIM5_CH1/);
    expect(f.detail).toMatch(/Set AFRL0 = 1/);
    expect(cites(f)).toEqual(['GPIOA_MODER.MODER0=2', 'GPIOA_AFRL.AFRL0=2']);
  });
  it('is satisfied by any candidate pin on the right AF (USART2 on PA2/PA3 AF7)', () => {
    const { dx } = run('stm32f411', 'USART2_CR1 = 0x200c\nGPIOA_MODER = 0xA80000A0\nGPIOA_AFRL = 0x7700');
    expect(rules(dx)).not.toContain('pin-mux');
  });
  it('ignores AF0 debug pins and says when no dumped pin is routed', () => {
    // PA15 is AF mode AF0 (JTDI) at reset; PA0 and PA5 are inputs.
    const { dx } = run('stm32f411', 'TIM2_CCER = 0x1\nGPIOA_MODER = 0xA8000000\nGPIOA_AFRL = 0\nGPIOA_AFRH = 0');
    const f = dx.findings.find((x) => x.rule === 'pin-mux')!;
    expect(f.title).toBe('No dumped pin is routed to TIM2_CH1');
    expect(f.severity).toBe('warn');
  });
  it('skips signals the peripheral has turned off (TE = 0 means no TX pin check)', () => {
    const { dx } = run('stm32f411', 'USART2_CR1 = 0x2004\nGPIOA_MODER = 0xA8000000\nGPIOA_AFRL = 0');
    const titles = dx.findings.filter((x) => x.rule === 'pin-mux').map((x) => x.title);
    expect(titles).toEqual(['No dumped pin is routed to USART2_RX']);
  });
  it('F103: a USART TX pin set as general-purpose push-pull', () => {
    const ex = DOCTOR_EXAMPLES.find((e) => e.id === 'bluepill-uart')!;
    const { dx } = run(ex.chip, ex.dump, { question: ex.question });
    const f = dx.findings.find((x) => x.rule === 'pin-mux')!;
    expect(f.title).toBe('PA9 is a general-purpose output, not USART1_TX');
    expect(cites(f)).toEqual(['GPIOA_CRH.MODE9=3', 'GPIOA_CRH.CNF9=0']);
  });
});

describe('rule: output-as-input', () => {
  it('ODR bit set on an input pin', () => {
    const { dx } = run('stm32f407', 'GPIOD_MODER = 0\nGPIOD_ODR = 0x1000');
    const f = dx.findings.find((x) => x.rule === 'output-as-input')!;
    expect(f.title).toBe('PD12 is an input, not an output');
    expect(cites(f)).toContain('GPIOD_ODR.ODR12=1');
  });
  it('a pin the question calls an LED, left in input mode', () => {
    const { dx } = run('stm32f411', 'GPIOC_MODER = 0', { question: 'PC13 LED never lights' });
    expect(dx.findings.find((x) => x.rule === 'output-as-input')?.title).toBe('PC13 is an input, not an output');
  });
  it('no finding for a real output, or for an F103 pull-up input (ODR picks the pull)', () => {
    expect(rules(run('stm32f411', 'GPIOC_MODER = 0x04000000\nGPIOC_ODR = 0x2000').dx)).not.toContain('output-as-input');
    // PA0: MODE0 = 00, CNF0 = 10 (pull-up/down input), ODR0 = 1 selects pull-up.
    expect(rules(run('stm32f103', 'GPIOA_CRL = 0x44444448\nGPIOA_ODR = 0x1').dx)).not.toContain('output-as-input');
  });
});

describe('rule: not-enabled', () => {
  it('USART with UE = 0', () => {
    const f = run('stm32f411', 'USART2_BRR = 0x1b2\nUSART2_CR1 = 0x000c').dx.findings.find((x) => x.rule === 'not-enabled')!;
    expect(f.title).toBe('USART2 is disabled');
    expect(cites(f)).toEqual(['USART2_CR1.UE=0']);
  });
  it('PWM channel with CCxE = 0, and a stopped counter', () => {
    const { dx } = run('stm32f411', 'TIM3_CR1 = 0\nTIM3_CCMR1_Output = 0x68\nTIM3_CCER = 0\nTIM3_PSC = 99\nTIM3_ARR = 999');
    expect(dx.findings.filter((x) => x.rule === 'not-enabled').map((x) => x.title)).toEqual([
      'TIM3 channel 1 output is disabled',
      'TIM3 counter is stopped',
    ]);
  });
  it('TIM1 outputs held off by BDTR.MOE = 0', () => {
    const { dx } = run('stm32f411', 'TIM1_CR1 = 1\nTIM1_CCMR1_Output = 0x68\nTIM1_CCER = 1\nTIM1_BDTR = 0');
    const f = dx.findings.find((x) => x.title === 'TIM1 outputs are held off by MOE')!;
    expect(cites(f)).toEqual(['TIM1_BDTR.MOE=0']);
  });
});

describe('rule: baud-error and computed quantities', () => {
  it('Black Pill example: 359,712 baud vs 115,200, BRR right only for 16 MHz', () => {
    const ex = DOCTOR_EXAMPLES.find((e) => e.id === 'blackpill-uart')!;
    const { dx } = run(ex.chip, ex.dump, { question: ex.question });
    expect(rules(dx)).toEqual(['baud-error']);
    const f = dx.findings[0];
    expect(f.title).toBe('USART2 runs at 359,712 baud, not 115,200');
    expect(f.detail).toMatch(/16\.013 MHz \(HSI\)/);
    expect(f.detail).toMatch(/BRR = 0x01B2/);
    const q = dx.quantities[0];
    expect(Math.round(q.numbers.baud!)).toBe(359712);
    expect(q.numbers.errorPct).toBeCloseTo(212.25, 1);
  });
  it('a typed target baud wins over the question', () => {
    const { dx } = run('stm32f411', RCC_F411 + 'RCC_APB1ENR = 0x20000\nUSART2_BRR = 0x1b2\nUSART2_CR1 = 0x200c', { question: '9600', targetBaud: 115200 });
    expect(rules(dx)).toEqual([]);
    expect(dx.quantities[0].numbers.target).toBe(115200);
  });
  it('without a target, compares with the nearest standard rate and only warns', () => {
    const { dx } = run('stm32f411', RCC_F411 + 'USART2_BRR = 0x8b\nUSART2_CR1 = 0x200c');
    expect(dx.findings.find((x) => x.rule === 'baud-error')?.severity).toBe('warn');
  });
  it('asks for a clock instead of guessing one', () => {
    const { dx } = run('stm32f411', 'USART2_BRR = 0x8b');
    expect(dx.quantities[0].display).toBeUndefined();
    expect(dx.quantities[0].needs).toMatch(/APB1 clock/);
  });
  it('Black Pill PWM example: 1 kHz at 25% from TIM2 at 100 MHz, plus the AF finding', () => {
    const ex = DOCTOR_EXAMPLES.find((e) => e.id === 'blackpill-pwm')!;
    const { dx } = run(ex.chip, ex.dump, { question: ex.question });
    expect(rules(dx)).toEqual(['pin-mux']);
    expect(dx.quantities[0]).toMatchObject({ title: 'TIM2 CH1 PWM', display: '1 kHz, 25% duty' });
  });
  it('every example produces at least one error finding', () => {
    for (const ex of DOCTOR_EXAMPLES) {
      const { dx } = run(ex.chip, ex.dump, { question: ex.question });
      expect(dx.findings.some((f) => f.severity === 'error'), ex.id).toBe(true);
    }
  });
});

describe('verifyDoctorReply', () => {
  const ex = DOCTOR_EXAMPLES.find((e) => e.id === 'blackpill-uart')!;
  const { m, dx } = run(ex.chip, ex.dump, { question: ex.question });
  const o = { hseHz: 25e6, question: ex.question };

  it('accepts a reply that copies fields and numbers, including the suggested fix', () => {
    const reply =
      'USART2 runs at 359,712 baud instead of 115,200 because BRR was computed for a 16.013 MHz clock while APB1 is 50 MHz.\n' +
      '- USART2_BRR.DIV_Mantissa = 8 and DIV_Fraction = 0b1011 give +212.3% error.\n- Set BRR = 0x01B2 for 115,200 baud at 50 MHz.';
    expect(verifyDoctorReply(reply, m, dx, o)).toEqual([]);
  });
  it('rejects a wrong field value and an invented number', () => {
    const errors = verifyDoctorReply('USART2_BRR.DIV_Mantissa = 9, so it runs at 230,400 baud with 5% error at 42 MHz.', m, dx, o);
    expect(errors).toEqual([
      'USART2_BRR.DIV_MANTISSA is 8, not 9',
      "230,400 baud isn't a number RegLens computed",
      "5% isn't a number RegLens computed",
      "42 MHz isn't a number RegLens computed",
    ]);
  });
  it('fallback summary lists findings and computed numbers', () => {
    const s = findingsSummary(dx);
    expect(s).toMatch(/RegLens found 1 issue/);
    expect(s).toMatch(/USART2 baud rate: 359,712 baud/);
  });
});
