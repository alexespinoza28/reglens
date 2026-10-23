# How RegLens works

Everything that has to be right is deterministic TypeScript over SVD data, in `src/lib/`, used by both the browser and the server functions. The AI explains or proposes; the library checks.

## Data

`scripts/svd_to_json.ts` (`npm run svd`) converts each SVD in `data/svd/` to compact JSON in `public/svd/`. It resolves `derivedFrom` on peripherals, clusters, registers, fields and enumerated values (bare names searched in enclosing scopes, dotted paths walked through clusters), expands `dim` arrays and clusters, inherits size, access and reset, and dedupes named-value tables. All four chips convert with zero unresolved references.

ST's raw SVDs name no field values, so they can't say that `MODER = 10` means "Alternate function". The [stm32-rs](https://github.com/stm32-rs/stm32-rs) patched SVDs add thousands of named values per chip; RegLens uses those.

## Single-register decoder (`src/lib/decode.ts`)

`parseValue` accepts hex, bare hex, decimal, binary, signed decimal and GDB's `$1 = 0x...`. `decode` slices fields with arithmetic rather than 32-bit bitwise operators (JavaScript's are signed), matches named values, compares with reset and finds set reserved bits.

## Peripheral doctor

1. **Parse** (`src/lib/dump.ts`): `parseDump` reads GDB `x/Nwx` rows (with or without `<symbol>`), OpenOCD `mdw` rows, `NAME = value` / `NAME: value` lines, `ADDR = value` lines, `p/x NAME` followed by `$n = value`, and `p/x *PERIPH` struct output (including `AFR = {a, b}` and pretty-printed structs). Unreadable lines are listed with a reason.
2. **Map**: `mapDump` resolves each address through an index of every register address. Overlapping registers (`TIMx_CCMR1_Output` / `_Input`) are chosen by the CCxS bits. 16-bit registers are masked, duplicates keep the last value, and non-zero words in gaps are reported.
3. **Clocks** (`src/lib/clocks.ts`): F407/F411 from `RCC_CFGR.SWS/HPRE/PPRE1/PPRE2` and `RCC_PLLCFGR.PLLSRC/PLLM/PLLN/PLLP` (plus F411 `RCC_DCKCFGR.TIMPRE`); F103 from `RCC_CFGR.SWS/PLLSRC/PLLXTPRE/PLLMUL/...`. Timer clocks are PCLK when the APB prescaler is 1, else 2 × PCLK. HSE comes from the board default (25 MHz Black Pill, 8 MHz otherwise) or the input box. Typed APB/timer clocks override derived ones. H743 clocks are typed in only.
4. **Rules** (`src/lib/doctor.ts`), each citing `REGISTER.FIELD = value (meaning)` exactly as decoded:
   - `clock-off`: the peripheral's RCC enable bit (`GPIOAEN`, `USART2EN`, F103 `IOPAEN`) is 0.
   - `pin-mux`: for each signal the peripheral is using (TX if `TE = 1`, CHn if `CCnE = 1`, ...), the candidate pins from `src/lib/afmap.ts` must be in AF mode with the right AF number. On F103, an output signal on a general-purpose output pin is an error (default pinout, no AFIO remap).
   - `output-as-input`: ODR bit set, or a pin the question calls an LED/output, while in input or analog mode.
   - `not-enabled`: USART `UE/TE/RE`, timer `CEN`, PWM channel `CCxE`, TIM1/TIM8 `BDTR.MOE`.
   - `baud-error`: actual baud more than 2% from the target (typed, or found in the question) or, without a target, from the nearest standard rate. The finding gives the clock that BRR would have been right for, and the corrected BRR.
5. **Math**: USART baud = f_CK / (8 × (2 − OVER8) × USARTDIV) with USARTDIV = mantissa + fraction/16 (or /8 with OVER8) on F1/F4; H7 uses the 16-bit BRR and PRESC (RM0433). PWM frequency = f_TIM / ((PSC + 1) × (ARR + 1)) edge-aligned or / ((PSC + 1) × 2 × ARR) center-aligned; duty = CCR / (ARR + 1), inverted for PWM mode 2.

When a check needs a register that isn't in the dump, RegLens says which one and gives the `x/1wx` address instead of guessing.

## Explain (`api/explain.ts`)

The browser sends only identifiers and raw text: `{chip, register, value}` for one register, or `{chip, dump, clocks, question}` for the doctor. The server re-runs the same library, so the model never sees anything the decoder didn't produce.

- Single register: facts are one line per field, with identical neighbors grouped. Every `FIELD = 0b…` claim in the reply is checked against the decode.
- Doctor: facts are the findings with their evidence, the computed numbers with formulas, the clocks and the changed fields. Every `REGISTER.FIELD = value` and `FIELD = value` claim must match the dump (or a fix a finding suggests), and every number with a unit (Hz, kHz, MHz, baud, %) must be one RegLens computed.

A divider quoted by its meaning (`PPRE1 = 2` for Div2) and any number the facts themselves state (VCO, baud at HSI) are accepted. Numbers must start a token, so "USART2 baud rate" is not read as 2 baud, and a frequency named after a clock ("APB1 runs at 50 MHz") must equal that clock. A reply that fails is retried once at temperature 0 with the misstatements listed; if it still fails, the deterministic summary (every finding in full, with evidence) is shown instead, and the response lists the refused claims under `rejected`.

## Write a config (`api/propose.ts`, `src/lib/propose.ts`)

1. `proposalContext` picks the registers the request names: a pin (`PA5`) brings that pin's MODER/OTYPER/OSPEEDR/PUPDR/ODR/AFR fields (CRL/CRH on F103); a peripheral (`USART2`, `TIM2`) brings its configuration registers; both bring the RCC enable bit. Each field is listed with its bits and named values.
2. `computedPlan` does the arithmetic the model is bad at, from the request itself: BRR from the baud rate and stated clock, PSC/ARR/CCR from the PWM frequency, duty and timer clock (ARR + 1 = 1000 when it divides evenly), plus the enable bits those setups need (UART `UE/TE/RE`, `OVER8`; timer `OCxM = 6`, `CCxE`, `CEN`; the RCC enable). These go into the prompt as RegLens-computed facts, and again in the retry.
3. Nemotron replies with JSON: field values with the meaning it intends. Division of labor, stated plainly: the model interprets the request and drafts; RegLens fills derived fields, writes the C, and verifies. `mergeDerived` drops registers listed without fields and adds every field RegLens derived from the request that the draft left out (computed BRR/PSC/ARR/CCR, required enables, GPIO mode/type/pull/AF/speed words, the port clock), marked "added by RegLens" in the UI and listed in the checks. A value the model set differently is kept as the model's, so the checks still fail it and trigger the retry. Output speed words follow the SVD names; MHz figures are mapped only for F103 MODE (2/10/50 MHz) and F407/F411 OSPEEDR (RM0090's 2/25/50/100 MHz classes), and are a note elsewhere. The model does not write C: `generateC` writes one read-modify-write per register from the field values (a plain write when the fields cover the whole register), RCC first. A note that mentions fields the writes don't set is dropped.
4. `verifyProposal` checks: the registers and fields exist and are writable; values fit and are named values; the stated meanings match the SVD names; the request's words (input/output/alternate/analog, push-pull/open-drain, pull-up/down/none, AFn, F103 speed) and numbers (baud at a stated clock, PWM frequency and duty at a stated timer clock) match; a UART configuration turns on `UE`, `TE` and `RE` (unless the request says TX or RX only) and a PWM request sets `CEN`; and the C lines, run by `runC` (integer literals, `~ << >> | & ^ + - *`, parentheses and casts; any other name is rejected) from four start values, set exactly the proposed fields and leave every other bit alone.
5. A failing proposal is sent back once with the failures. The browser re-runs `verifyProposal` on its own copy of the chip data and shows the badge from that result. A proposal that fails is shown as **Not verified**, with the C struck through and no copy button.

## Model client (`api/_nvidia.ts`)

Time limits: each model call is capped at 20 s and the whole request at about 45 s (Vercel's limit is 60 s); a retry is skipped if it can't finish in time. Responses include `timings` (model, ms, outcome per call). The browser shows elapsed seconds and gives up after 58 s.


Calls `https://integrate.api.nvidia.com/v1/chat/completions` with plain `fetch`. It tries a list of Nemotron models in order and skips any the key can't reach (HTTP 404), remembers the one that answered, retries once without `chat_template_kwargs` on HTTP 400, maps 401/403/402/429 to clear messages, redacts keys from error text, and strips `<think>` blocks. `NVIDIA_MODEL` pins a model.

## Tests

`node scripts/live_check.mjs https://reglens-five.vercel.app all 2` measures live pass rates for the doctor examples and three Write requests against a deployment. `npm test` runs Vitest over `tests/`: dump parsing, address mapping, each rule, the baud/PWM/clock formulas, write-mode verification and the C interpreter, the single-register Explain checks, and both API routes end to end with the model stubbed.

## Layout

```
api/            explain.ts, propose.ts, _nvidia.ts (shared client, not a route)
src/lib/        decode, search, dump, clocks, afmap, doctor, propose, cite, share, examples
src/components/ DecodeView, DoctorView, WriteView, Findings, ExplainPanel, BitfieldStrip, FieldTable, RegisterSearch
scripts/        svd_to_json.ts
tests/          Vitest
devpost/        scope.md, prd.md, spec.md (generated with the skill pack)
```
