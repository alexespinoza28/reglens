import { describe, expect, it } from 'vitest';
import { parseIntent, parseProposal, proposalContext, runC, splitC, verifyProposal, type Proposal } from '../src/lib/propose';
import { device } from './helpers';

const f411 = () => device('stm32f411');
const fails = (v: ReturnType<typeof verifyProposal>) => v.checks.filter((c) => c.status === 'fail').map((c) => c.text);

const PA5_OUT: Proposal = {
  writes: [
    { register: 'RCC_AHB1ENR', fields: [{ name: 'GPIOAEN', value: 1, meaning: 'Enabled' }] },
    { register: 'GPIOA_MODER', fields: [{ name: 'MODER5', value: 1, meaning: 'Output' }] },
    { register: 'GPIOA_OTYPER', fields: [{ name: 'OT5', value: 0, meaning: 'PushPull' }] },
    { register: 'GPIOA_PUPDR', fields: [{ name: 'PUPDR5', value: 0, meaning: 'Floating' }] },
  ],
  c: [
    'RCC->AHB1ENR |= (1U << 0);',
    'GPIOA->MODER = (GPIOA->MODER & ~(0x3U << 10)) | (0x1U << 10);',
    'GPIOA->OTYPER &= ~(1U << 5);',
    'GPIOA->PUPDR &= ~(3U << 10);',
  ],
};
const REQ = 'PA5 push-pull output, no pull';

describe('parseProposal', () => {
  it('extracts JSON from fences and prose, with field arrays or maps and 0b/0x values', () => {
    const p = parseProposal('Here you go:\n```json\n{"writes":[{"register":"GPIOA->MODER","fields":{"MODER5":"0b01"}}],"c":"GPIOA->MODER |= 1U << 10;"}\n```');
    expect(p).toEqual({ writes: [{ register: 'GPIOA->MODER', fields: [{ name: 'MODER5', value: 1, meaning: undefined }] }], c: ['GPIOA->MODER |= 1U << 10;'], notes: undefined });
  });
  it('reports a reply without usable JSON', () => {
    expect(parseProposal('Sorry, I cannot help')).toEqual({ error: 'reply had no JSON object' });
    expect(parseProposal('{"c": []}')).toEqual({ error: 'reply JSON has no "writes" array' });
  });
});

describe('runC', () => {
  const sizes = () => 32;
  const resolve = (c: string) => ({ 'GPIOA->MODER': 'GPIOA_MODER', 'GPIOA->AFR[0]': 'GPIOA_AFRL' })[c];
  it('evaluates read-modify-write with C precedence and 32-bit unsigned wraparound', () => {
    const env = new Map([['GPIOA_MODER', 0xa8000000]]);
    runC(splitC(['GPIOA->MODER = (GPIOA->MODER & ~(0x3U << 10)) | (0x1U << 10);']), env, resolve, sizes);
    expect(env.get('GPIOA_MODER')).toBe(0xa8000400);
    runC(['GPIOA->MODER &= ~(3 << 30)', 'GPIOA->AFR[0] = (uint32_t)7 << 8 | 7 << 12'], env, resolve, sizes);
    expect(env.get('GPIOA_MODER')).toBe(0x28000400);
    expect(env.get('GPIOA_AFRL')).toBe(0x7700);
  });
  it('rejects macros, unknown registers and oversized shifts', () => {
    const env = new Map<string, number>();
    expect(() => runC(['GPIOA->MODER |= GPIO_MODER_MODER5_0'], env, resolve, sizes)).toThrow(/GPIO_MODER_MODER5_0/);
    expect(() => runC(['GPIOZ->MODER = 1'], env, resolve, sizes)).toThrow(/not a register/);
    expect(() => runC(['GPIOA->MODER = 1U << 32'], env, resolve, sizes)).toThrow(/shift/);
  });
});

describe('parseIntent', () => {
  it('reads pins, mode, type, pull, AF and numbers', () => {
    expect(parseIntent('PA2 and PA3 alternate function AF7, pull-up')).toMatchObject({ mode: 'af', af: 7, pull: 1, pins: [{ pin: 'PA2' }, { pin: 'PA3' }] });
    expect(parseIntent('PC13 open-drain output, no pull')).toMatchObject({ mode: 'output', otype: 1, pull: 0 });
    expect(parseIntent('USART2 115200 baud at 50 MHz APB1')).toMatchObject({ baud: 115200, clockHz: 50e6 });
    expect(parseIntent('TIM2 channel 1 PWM at 1 kHz, 25% duty, timer clock 100 MHz')).toMatchObject({ pwmHz: 1000, dutyPct: 25, channel: 1, clockHz: 100e6 });
  });
});

describe('verifyProposal', () => {
  it('verifies a correct proposal: fields, meanings, request words and C lines', () => {
    const v = verifyProposal(f411(), REQ, PA5_OUT);
    expect(fails(v)).toEqual([]);
    expect(v.verified).toBe(true);
    expect(v.results.find((r) => r.key === 'GPIOA_MODER')?.value).toBe(0xa8000400);
  });
  it('fails when the stated meaning is not the SVD name for the value', () => {
    const p = structuredClone(PA5_OUT);
    p.writes[1].fields[0].meaning = 'Alternate';
    expect(fails(verifyProposal(f411(), REQ, p))).toEqual(['GPIOA_MODER.MODER5 = 1 is "Output" in the SVD, but the proposal calls it "Alternate".']);
  });
  it('fails when the values do not match the request', () => {
    const p = structuredClone(PA5_OUT);
    p.writes[2].fields[0] = { name: 'OT5', value: 1, meaning: 'OpenDrain' };
    p.c[2] = 'GPIOA->OTYPER |= (1U << 5);';
    expect(fails(verifyProposal(f411(), REQ, p))).toEqual(['The request asks for push-pull on PA5, but GPIOA_OTYPER.OT5 = 1.']);
  });
  it('fails when a C line clobbers other fields', () => {
    const p = structuredClone(PA5_OUT);
    p.c[1] = 'GPIOA->MODER = (1U << 10);';
    expect(fails(verifyProposal(f411(), REQ, p))[0]).toMatch(/also change GPIOA_MODER bit 27 \(MODER13\)/);
  });
  it('fails when the C lines disagree with the listed field values', () => {
    const p = structuredClone(PA5_OUT);
    p.c[1] = 'GPIOA->MODER = (GPIOA->MODER & ~(0x3U << 10)) | (0x2U << 10);';
    expect(fails(verifyProposal(f411(), REQ, p))[0]).toMatch(/leave GPIOA_MODER.MODER5 = 2, not 1/);
  });
  it('fails on unknown registers and fields, out-of-range values, and C that writes unlisted registers', () => {
    const p: Proposal = {
      writes: [
        { register: 'GPIOA_MODER', fields: [{ name: 'MODER5', value: 4 }] },
        { register: 'GPIOA_NOPE', fields: [] },
      ],
      c: ['GPIOB->MODER = 0;'],
    };
    const f = fails(verifyProposal(f411(), 'PA5 output', p));
    expect(f).toContain('GPIOA_MODER.MODER5 = 4 doesn\'t fit in 2 bits.');
    expect(f).toContain('GPIOA_NOPE is not a register on STM32F411.');
  });
  it('checks a BRR against the requested baud at the stated clock', () => {
    const good: Proposal = {
      writes: [{ register: 'USART2_BRR', fields: [{ name: 'DIV_Mantissa', value: 27 }, { name: 'DIV_Fraction', value: 2 }] }],
      c: ['USART2->BRR = (27U << 4) | 2U;'],
    };
    const req = 'USART2 115200 baud at 50 MHz APB1';
    expect(fails(verifyProposal(f411(), req, good))).toEqual([]);
    const bad = structuredClone(good);
    bad.writes[0].fields = [{ name: 'DIV_Mantissa', value: 8 }, { name: 'DIV_Fraction', value: 11 }];
    bad.c = ['USART2->BRR = 0x8BU;'];
    expect(fails(verifyProposal(f411(), req, bad))).toEqual(['The proposed BRR gives 359712 baud at 50 MHz, not 115200 (212.25%).']);
  });
  it('checks PWM frequency and duty, PWM mode and channel enable', () => {
    const p: Proposal = {
      writes: [
        { register: 'TIM2_PSC', fields: [{ name: 'PSC', value: 99 }] },
        { register: 'TIM2_ARR', fields: [{ name: 'ARR', value: 999 }] },
        { register: 'TIM2_CCR1', fields: [{ name: 'CCR', value: 250 }] },
        { register: 'TIM2_CCMR1_Output', fields: [{ name: 'OC1M', value: 6, meaning: 'PwmMode1' }] },
        { register: 'TIM2_CCER', fields: [{ name: 'CC1E', value: 1 }] },
        { register: 'TIM2_CR1', fields: [{ name: 'CEN', value: 1 }] },
      ],
      c: [
        'TIM2->PSC = 99U;',
        'TIM2->ARR = 999U;',
        'TIM2->CCR1 = 250U;',
        'TIM2->CCMR1 = (TIM2->CCMR1 & ~(0x7U << 4)) | (0x6U << 4);',
        'TIM2->CCER |= 1U;',
        'TIM2->CR1 |= 1U;',
      ],
    };
    const req = 'TIM2 channel 1 PWM mode 1 at 1 kHz, 25% duty, timer clock 100 MHz';
    expect(fails(verifyProposal(f411(), req, p))).toEqual([]);
    const half = structuredClone(p);
    half.writes[2].fields[0].value = 500;
    half.c[2] = 'TIM2->CCR1 = 500U;';
    expect(fails(verifyProposal(f411(), req, half))).toEqual(['CCR1 500 gives 50.0% duty, not 25%.']);
  });
  it('F103: output speed maps to MODE, push-pull to CNF', () => {
    const p: Proposal = {
      writes: [{ register: 'GPIOC_CRH', fields: [{ name: 'MODE13', value: 2, meaning: 'Output2' }, { name: 'CNF13', value: 0, meaning: 'PushPull' }] }],
      c: ['GPIOC->CRH = (GPIOC->CRH & ~(0xFU << 20)) | (0x2U << 20);'],
    };
    expect(fails(verifyProposal(device('stm32f103'), 'PC13 push-pull output 2 MHz', p))).toEqual([]);
    expect(fails(verifyProposal(device('stm32f103'), 'PC13 push-pull output 50 MHz', p))).toEqual([
      'The request asks for an output at 50 MHz on PC13, but GPIOC_CRH.MODE13 = 2.',
    ]);
  });
});

describe('proposalContext', () => {
  it('lists the pin fields, peripheral registers and RCC enable bits a request needs', () => {
    const ctx = proposalContext(f411(), 'PA5 output and USART2 115200 baud');
    if ('error' in ctx) throw new Error(ctx.error);
    expect(ctx.keys).toEqual(expect.arrayContaining(['GPIOA_MODER', 'GPIOA_AFRL', 'USART2_BRR', 'USART2_CR1', 'RCC_AHB1ENR', 'RCC_APB1ENR']));
    expect(ctx.text).toMatch(/MODER5 bits \[11:10\] values: 0=Input, 1=Output, 2=Alternate, 3=Analog/);
    expect(ctx.text).toMatch(/GPIOA_AFRL \(C: GPIOA->AFR\[0\]\)/);
    expect(ctx.text).not.toMatch(/MODER6/);
  });
  it('asks for a pin or peripheral when the request names neither', () => {
    expect(proposalContext(f411(), 'make the LED blink')).toEqual({ error: expect.stringMatching(/Name a pin/) });
  });
});
