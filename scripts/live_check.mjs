// Live pass rates for Explain (doctor) and Write against a deployed RegLens. The server
// holds the NVIDIA key; this script only sends the example inputs.
// usage: node scripts/live_check.mjs <baseUrl> [explain|propose|all] [runs] [-v]
import { DOCTOR_EXAMPLES } from '../src/lib/examples.ts';
const [base, which = 'all', runsArg = '2'] = process.argv.slice(2);
const runs = Number(runsArg);
const verbose = process.argv.includes('-v');
const HSE = { stm32f411: 25e6, stm32f103: 8e6 };
const post = async (path, body) => {
  const t = Date.now();
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ms: Date.now() - t, body: await r.json().catch(() => ({})) };
};
const tally = {};
const log = (name, ok, detail) => { (tally[name] ??= []).push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };
for (let i = 0; i < runs; i++) {
  if (which !== 'propose') for (const ex of DOCTOR_EXAMPLES) {
    const { status, ms, body: b } = await post('/api/explain', { chip: ex.chip, dump: ex.dump, question: ex.question, hseHz: HSE[ex.chip] });
    log(`explain ${ex.id}`, status === 200 && b.model !== 'decoder', `${status} ${b.model ?? b.error} ${ms}ms${b.rejected ? ` rejected=${JSON.stringify(b.rejected)}` : ''}`);
    if (verbose) console.log('   ' + String(b.text).replace(/\n/g, ' | '));
  }
  if (which !== 'explain') for (const [chip, text] of [
    ['stm32f411', 'USART2 115200 baud at 50 MHz APB1'],
    ['stm32f411', 'PA5 push-pull output, 50 MHz, no pull'],
    ['stm32f411', 'TIM2 channel 1 PWM at 1 kHz, 25% duty, timer clock 100 MHz'],
  ]) {
    const { status, ms, body: b } = await post('/api/propose', { chip, request: text });
    const v = b.verification;
    log(`propose "${text}"`, status === 200 && !!v?.verified, `${status} attempts=${b.attempts} ${ms}ms ${v ? v.checks.filter((c) => c.status === 'fail').map((c) => c.text).join(' | ') : b.error}`);
    if (verbose || !v?.verified) console.log(`   writes=${JSON.stringify(b.proposal?.writes)} c=${JSON.stringify(b.proposal?.c)} notes=${b.proposal?.notes ?? ''}`);
  }
}
console.log('\nPASS RATES');
for (const [k, v] of Object.entries(tally)) console.log(`${v.filter(Boolean).length}/${v.length}  ${k}`);
