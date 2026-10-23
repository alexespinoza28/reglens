// The API routes end to end with the NVIDIA endpoint stubbed: request
// validation, model reply parsing, verification, the one retry, and the
// deterministic fallback. No network, no real key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as explain } from '../api/explain';
import { POST as propose } from '../api/propose';
import { DOCTOR_EXAMPLES } from '../src/lib/examples';

function stubModel(replies: string[]) {
  const calls: { model: string; temperature: number; user: string }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string; temperature: number; messages: { content: string }[] };
    calls.push({ model: body.model, temperature: body.temperature, user: body.messages[1].content });
    const content = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }] }), { status: 200 });
  });
  return calls;
}
const post = (fn: (r: Request) => Promise<Response>, body: unknown) =>
  fn(new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  process.env.NVIDIA_API_KEY = 'test-key-not-real';
  delete process.env.NVIDIA_MODEL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NVIDIA_API_KEY;
});

const GOOD = JSON.stringify({
  writes: [
    { register: 'GPIOA_MODER', fields: [{ name: 'MODER5', value: 1, meaning: 'Output' }] },
    { register: 'GPIOA_OTYPER', fields: [{ name: 'OT5', value: 0, meaning: 'PushPull' }] },
    { register: 'GPIOA_PUPDR', fields: [{ name: 'PUPDR5', value: 0, meaning: 'Floating' }] },
  ],
  c: [
    'GPIOA->MODER = (GPIOA->MODER & ~(0x3U << 10)) | (0x1U << 10);',
    'GPIOA->OTYPER &= ~(0x1U << 5);',
    'GPIOA->PUPDR &= ~(0x3U << 10);',
  ],
});
const WRONG = GOOD.replace('"value":1,"meaning":"Output"', '"value":2,"meaning":"Alternate"').replace('(0x1U << 10)', '(0x2U << 10)');

describe('/api/propose', () => {
  it('returns a verified proposal on the first try', async () => {
    const calls = stubModel([GOOD]);
    const res = await post(propose, { chip: 'stm32f411', request: 'PA5 push-pull output, no pull' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.verification.verified).toBe(true);
    expect(body.attempts).toBe(1);
    expect(calls[0].user).toMatch(/MODER5 bits \[11:10\] values: 0=Input, 1=Output/);
  });
  it('retries once with the failed checks, and returns the corrected proposal', async () => {
    const calls = stubModel([WRONG, GOOD]);
    const body = await (await post(propose, { chip: 'stm32f411', request: 'PA5 push-pull output, no pull' })).json();
    expect(calls).toHaveLength(2);
    expect(calls[1].temperature).toBe(0);
    expect(calls[1].user).toMatch(/rejected by the checker:\n- The request asks for output mode on PA5, but GPIOA_MODER.MODER5 = 2/);
    expect(body).toMatchObject({ attempts: 2, verification: { verified: true } });
  });
  it('returns a not-verified proposal when the retry is still wrong', async () => {
    stubModel([WRONG, WRONG]);
    const body = await (await post(propose, { chip: 'stm32f411', request: 'PA5 push-pull output, no pull' })).json();
    expect(body.verification.verified).toBe(false);
  });
  it('rejects requests without a pin or peripheral, and returns 502 for a non-JSON reply', async () => {
    stubModel(['I would set the pin to output.']);
    expect((await post(propose, { chip: 'stm32f411', request: 'make it blink' })).status).toBe(400);
    expect((await post(propose, { chip: 'stm32f411', request: 'PA5 output' })).status).toBe(502);
  });
  it('explains that Write needs a key when none is set', async () => {
    delete process.env.NVIDIA_API_KEY;
    expect((await post(propose, { chip: 'stm32f411', request: 'PA5 output' })).status).toBe(503);
  });
});

describe('/api/explain doctor mode', () => {
  const ex = DOCTOR_EXAMPLES.find((e) => e.id === 'blackpill-uart')!;
  const req = { chip: ex.chip, dump: ex.dump, question: ex.question, hseHz: 25e6 };

  it('re-runs the doctor on the server and returns a reply that passes the checks', async () => {
    const reply = 'USART2 runs at 359,712 baud, not 115,200: BRR was computed for a 16.013 MHz clock but APB1 is 50 MHz.\n- Set BRR = 0x01B2.';
    const calls = stubModel([reply]);
    const body = await (await post(explain, req)).json();
    expect(body).toMatchObject({ text: reply, verified: true });
    expect(calls[0].user).toMatch(/\[error\] USART2 runs at 359,712 baud, not 115,200/);
    expect(calls[0].user).toMatch(/Evidence: USART2_BRR.DIV_Mantissa = 8/);
  });
  it('falls back to the deterministic findings when the reply invents numbers twice', async () => {
    stubModel(['USART2 runs at 230,400 baud.', 'USART2 runs at 230,400 baud.']);
    const body = await (await post(explain, req)).json();
    expect(body.model).toBe('decoder');
    expect(body.text).toMatch(/^RegLens found 1 issue:/);
  });
  it('keeps the single-register mode working', async () => {
    stubModel(['GPIOA_MODER sets PA5 as an input: MODER5 = 0b00.']);
    const body = await (await post(explain, { chip: 'stm32f407', register: 'GPIOA_MODER', value: '0xABFFF3FF' })).json();
    expect(body.verified).toBe(true);
    expect(body.text).toMatch(/MODER5 = 0b00/);
  });
});
