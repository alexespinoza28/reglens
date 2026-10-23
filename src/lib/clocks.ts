// Clock tree from RCC registers in a dump, or from clocks typed in by hand.
//
// STM32F407/F411 (RM0090, RM0383 "Clocks"): SYSCLK from RCC_CFGR.SWS; PLL
//   output = (PLL input / PLLM) * PLLN / PLLP, input = HSI (16 MHz) or HSE.
// STM32F103 (RM0008 "Clocks"): PLL = (HSI/2 or HSE [/2 with PLLXTPRE]) * PLLMUL.
// All three: HCLK = SYSCLK / HPRE, PCLKx = HCLK / PPREx, and timers on an APB
// bus run at PCLKx when its prescaler is 1, otherwise at 2 * PCLKx.
// F411 RCC_DCKCFGR.TIMPRE = 1 changes that to HCLK (prescaler 1, 2, 4) or 4 * PCLKx.
// STM32H743: not derived here; type the clocks in.

import { cite, type Cite } from './cite.js';
import type { DumpView } from './dump.js';
import type { DeviceJson } from './types.js';

export type Bus = 'ahb' | 'apb1' | 'apb2' | 'other';

export interface Clock {
  hz?: number;
  source: 'rcc' | 'manual' | 'unknown';
}

export interface Clocks {
  sysclk: Clock;
  hclk: Clock;
  pclk1: Clock;
  pclk2: Clock;
  /** Timer kernel clocks for timers on APB1 / APB2. */
  tim1: Clock;
  tim2: Clock;
  /** Fields the derived clocks came from. */
  cites: Cite[];
  /** One line per derivation step, for the clock panel. */
  steps: string[];
  notes: string[];
}

export interface ClockOverrides {
  hseHz?: number;
  apb1Hz?: number;
  apb2Hz?: number;
  tim1Hz?: number;
  tim2Hz?: number;
}

export type Family = 'f1' | 'f4' | 'h7' | 'unknown';

export function family(device: DeviceJson): Family {
  const rcc = device.peripherals.find((p) => p.name === 'RCC');
  const reg = (n: string) => rcc?.registers.find((r) => r.name === n);
  if (reg('D1CFGR')) return 'h7';
  if (reg('PLLCFGR')) return 'f4';
  if (reg('CFGR')?.fields.some((f) => f.name === 'PLLMUL')) return 'f1';
  return 'unknown';
}

/** Board defaults for the HSE crystal, in Hz. Editable in the UI. */
export const DEFAULT_HSE: Record<string, number> = {
  stm32f103: 8_000_000, // Blue Pill
  stm32f407: 8_000_000, // STM32F4DISCOVERY
  stm32f411: 25_000_000, // WeAct Black Pill
  stm32h743: 8_000_000, // Nucleo-H743ZI (ST-LINK MCO)
};

const HPRE_DIV = [2, 4, 8, 16, 64, 128, 256, 512];
export const hpreDiv = (v: number) => (v < 8 ? 1 : HPRE_DIV[v - 8]);
export const ppreDiv = (v: number) => (v < 4 ? 1 : [2, 4, 8, 16][v - 4]);

const MHz = (hz: number) => `${+(hz / 1e6).toFixed(3)} MHz`;

const known = (hz: number | undefined, source: Clock['source']): Clock =>
  hz === undefined ? { source: 'unknown' } : { hz, source };

export function deriveClocks(device: DeviceJson, view: DumpView, o: ClockOverrides): Clocks {
  const fam = family(device);
  const cites: Cite[] = [];
  const steps: string[] = [];
  const notes: string[] = [];
  const cfgr = view.reg('RCC_CFGR');
  const take = (key: string, field: string) => {
    const r = view.reg(key);
    const c = r && cite(r, field);
    if (c) cites.push(c);
    return c?.value;
  };

  let sys: number | undefined;
  let hclk: number | undefined;
  let pclk1: number | undefined;
  let pclk2: number | undefined;
  let ppre1: number | undefined;
  let ppre2: number | undefined;

  if ((fam === 'f4' || fam === 'f1') && cfgr) {
    const hsi = fam === 'f4' ? 16e6 : 8e6;
    const sws = take('RCC_CFGR', 'SWS')!;
    if (sws === 0) {
      sys = hsi;
      steps.push(`SYSCLK = HSI = ${MHz(hsi)} (RCC_CFGR.SWS = 0b00)`);
    } else if (sws === 1) {
      sys = o.hseHz;
      steps.push(`SYSCLK = HSE = ${o.hseHz ? MHz(o.hseHz) : 'unknown (enter HSE)'} (RCC_CFGR.SWS = 0b01)`);
    } else if (sws === 2 && fam === 'f4') {
      if (!view.has('RCC_PLLCFGR')) {
        notes.push('SYSCLK comes from the PLL; add RCC_PLLCFGR to the dump to derive it.');
      } else {
        const src = take('RCC_PLLCFGR', 'PLLSRC')!;
        const m = take('RCC_PLLCFGR', 'PLLM')!;
        const n = take('RCC_PLLCFGR', 'PLLN')!;
        const p = [2, 4, 6, 8][take('RCC_PLLCFGR', 'PLLP')!];
        const input = src ? o.hseHz : hsi;
        if (!m) notes.push('RCC_PLLCFGR.PLLM = 0 is not a valid PLL divider.');
        else if (input === undefined) notes.push('PLL runs from HSE; enter the HSE crystal frequency.');
        else {
          sys = (input / m) * n / p;
          const vco = (input / m) * n;
          steps.push(
            `SYSCLK = PLL = ${src ? 'HSE' : 'HSI'} ${MHz(input)} / PLLM ${m} × PLLN ${n} / PLLP ${p} = ${MHz(sys)} (PLL input ${MHz(input / m)}, VCO ${MHz(vco)})`,
          );
          if (input / m < 1e6 || input / m > 2e6) notes.push(`PLL input ${MHz(input / m)} is outside the 1–2 MHz range the reference manual allows.`);
          if (vco < 100e6 || vco > 432e6) notes.push(`VCO ${MHz(vco)} is outside 100–432 MHz.`);
        }
      }
    } else if (sws === 2 && fam === 'f1') {
      const src = take('RCC_CFGR', 'PLLSRC')!;
      const xt = take('RCC_CFGR', 'PLLXTPRE')!;
      const mulEnc = take('RCC_CFGR', 'PLLMUL')!;
      const mul = mulEnc >= 14 ? 16 : mulEnc + 2;
      const input = src ? (o.hseHz === undefined ? undefined : o.hseHz / (xt ? 2 : 1)) : 4e6;
      if (input === undefined) notes.push('PLL runs from HSE; enter the HSE crystal frequency.');
      else {
        sys = input * mul;
        steps.push(
          `SYSCLK = PLL = ${src ? `HSE${xt ? '/2' : ''}` : 'HSI/2'} ${MHz(input)} × PLLMUL ${mul} = ${MHz(sys)}`,
        );
        if (sys > 72e6) notes.push(`SYSCLK ${MHz(sys)} is above the F103's 72 MHz limit.`);
      }
    } else {
      notes.push(`RCC_CFGR.SWS = ${sws} is reserved.`);
    }

    const hpre = hpreDiv(take('RCC_CFGR', 'HPRE')!);
    ppre1 = ppreDiv(take('RCC_CFGR', 'PPRE1')!);
    ppre2 = ppreDiv(take('RCC_CFGR', 'PPRE2')!);
    if (sys !== undefined) {
      hclk = sys / hpre;
      pclk1 = hclk / ppre1;
      pclk2 = hclk / ppre2;
      steps.push(`HCLK = SYSCLK / ${hpre} = ${MHz(hclk)}`);
      steps.push(`PCLK1 (APB1) = HCLK / ${ppre1} = ${MHz(pclk1)}`);
      steps.push(`PCLK2 (APB2) = HCLK / ${ppre2} = ${MHz(pclk2)}`);
    }
  } else if (fam === 'h7') {
    notes.push('RegLens does not derive the H743 clock tree yet; type the APB and timer clocks.');
  } else if (!cfgr) {
    notes.push('No RCC_CFGR in the dump, so clocks are not derived. Add it, or type the APB clocks.');
  }

  const src = (manual: number | undefined, derived: number | undefined): Clock =>
    manual !== undefined ? { hz: manual, source: 'manual' } : known(derived, 'rcc');

  const p1 = src(o.apb1Hz, pclk1);
  const p2 = src(o.apb2Hz, pclk2);

  // Timer clocks follow the APB prescaler, so they need RCC_CFGR even when PCLK is typed.
  const timPre = fam === 'f4' ? view.field('RCC_DCKCFGR', 'TIMPRE') : undefined;
  if (timPre) cites.push(cite(view.reg('RCC_DCKCFGR')!, 'TIMPRE')!);
  const timer = (pclk: number | undefined, ppre: number | undefined, label: string): number | undefined => {
    if (pclk === undefined || ppre === undefined) return undefined;
    let hz: number;
    if (timPre) hz = ppre <= 4 && hclk !== undefined ? hclk : 4 * pclk;
    else hz = ppre === 1 ? pclk : 2 * pclk;
    steps.push(
      `${label} timers = ${timPre ? (ppre <= 4 ? 'HCLK (TIMPRE = 1)' : '4 × PCLK (TIMPRE = 1)') : ppre === 1 ? 'PCLK (APB prescaler 1)' : '2 × PCLK (APB prescaler > 1)'} = ${MHz(hz)}`,
    );
    return hz;
  };
  const t1 = o.tim1Hz !== undefined ? { hz: o.tim1Hz, source: 'manual' as const } : known(timer(p1.hz, ppre1, 'APB1'), p1.source === 'manual' ? 'manual' : 'rcc');
  const t2 = o.tim2Hz !== undefined ? { hz: o.tim2Hz, source: 'manual' as const } : known(timer(p2.hz, ppre2, 'APB2'), p2.source === 'manual' ? 'manual' : 'rcc');

  return {
    sysclk: known(sys, 'rcc'),
    hclk: known(hclk, 'rcc'),
    pclk1: p1,
    pclk2: p2,
    tim1: t1,
    tim2: t2,
    cites,
    steps,
    notes,
  };
}

/**
 * Which RCC enable bit gates a peripheral, and which bus that puts it on.
 * GPIOA -> RCC_AHB1ENR.GPIOAEN (F4), RCC_AHB4ENR.GPIOAEN (H7), RCC_APB2ENR.IOPAEN (F1).
 */
export function enableBit(device: DeviceJson, peripheral: string): { register: string; field: string; bus: Bus } | undefined {
  const rcc = device.peripherals.find((p) => p.name === 'RCC');
  if (!rcc) return undefined;
  const names = [`${peripheral}EN`];
  const gpio = peripheral.match(/^GPIO([A-K])$/);
  if (gpio) names.push(`IOP${gpio[1]}EN`);
  for (const r of rcc.registers) {
    if (!/ENR$/.test(r.name) || /LPENR$/.test(r.name) || /^C\d_/.test(r.name)) continue;
    const f = r.fields.find((x) => names.includes(x.name));
    if (f) {
      const bus: Bus = /APB1/.test(r.name) ? 'apb1' : /APB2/.test(r.name) ? 'apb2' : /AHB/.test(r.name) ? 'ahb' : 'other';
      return { register: `RCC_${r.name}`, field: f.name, bus };
    }
  }
  return undefined;
}

/** Bus clock and timer clock for a peripheral. */
export function clockFor(device: DeviceJson, clocks: Clocks, peripheral: string): { pclk: Clock; tim: Clock; bus: Bus } {
  const en = enableBit(device, peripheral);
  const bus = en?.bus ?? 'other';
  if (bus === 'apb1') return { pclk: clocks.pclk1, tim: clocks.tim1, bus };
  if (bus === 'apb2') return { pclk: clocks.pclk2, tim: clocks.tim2, bus };
  if (bus === 'ahb') return { pclk: clocks.hclk, tim: { source: 'unknown' }, bus };
  return { pclk: { source: 'unknown' }, tim: { source: 'unknown' }, bus };
}

export { MHz as formatMHz };
