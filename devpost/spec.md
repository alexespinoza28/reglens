---
doc: spec
status: draft
---
<!-- Generated with the Devpost Learn skill pack's 4-spec skill (challengepost/learn-ai-basics)
     from templates/spec-template.md and references/spec-patterns.md on Oct 22, 2026. Interview
     answered from Alex's written plan; see RESOURCES.md > Skill pack run.
     TODO(Alex): read it and set status: approved. -->

# RegLens — Technical Spec

## How This Works, In Plain Language

RegLens has four parts.

1. **A converter script** runs once, ahead of time. It reads each chip's SVD file (an XML description of every register, field and named value) and writes a compact JSON file per chip.
2. **A decoding library** in the browser. It slices a value into fields and names each one, and for the doctor it reads a pasted dump, matches each word to its register by address, works out the clock tree from RCC, and runs a handful of plain-code rules that compare registers with each other (is the GPIO clock on? does the pin's alternate function match the peripheral? what baud rate does this BRR really give?). No AI is involved in any of that.
3. **Two server functions** call NVIDIA's Nemotron model. *Explain* re-runs the same library on the server and asks the model to summarize what the library found; a checker compares every field value and every number in the reply with the library's output and throws out a reply that misstates one. *Write* sends the model your request plus the real fields of the registers involved, gets back proposed field values and C lines, and hands them to the library to verify.
4. **A verifier** in the library checks a proposal like a strict reviewer: fields exist, values fit and have the right SVD names, the request's words and numbers match, and the C lines, run in a tiny interpreter from several start values, change exactly those fields. Only a proposal that passes every check is shown as Verified.

Why this shape: anything that has to be right is plain code over vendor data, so it is testable and the same in the browser and on the server. The AI does the two things code is bad at, explaining in prose and turning a sentence into a register plan, and it is always checked by that code afterwards. Everything except Explain and Write works without a key.

## The Core Journey Through the System

PRD ref: `prd.md > The Core Journey`.

1. Page opens → `App` reads the URL hash → `useChipIndex` fetches `svd/index.json` → `useDevice` fetches `svd/<chip>.json`. Hash formats: `#stm32f407/GPIOA_MODER/0xABFFFFFF` (decoder, unchanged), `#doctor/<chip>/<payload>` and `#write/<chip>/<payload>`, where the payload is base64url JSON of the inputs.
2. Doctor: the user pastes text → `parseDump()` turns lines into address- or name-tagged words → `mapDump()` resolves each to a register via an address index (`PERIPH_REG` for names) and runs `decode()` on each → `deriveClocks()` reads RCC (or the typed clocks) → `diagnose()` runs the rules and computes baud/PWM → `DoctorView` renders findings, computed cards, clocks and register cards.
3. Explain findings → `ExplainPanel` POSTs `{chip, dump, clocks, targetBaud, question}` to `/api/explain` → the function re-runs steps 2's library calls, builds `doctorFactsText()`, calls Nemotron → `verifyDoctorReply()` checks field claims and numbers → returns `{text}` or the deterministic `findingsSummary()`.
4. Write → `WriteView` POSTs `{chip, request}` to `/api/propose` → the function picks the registers the request names (`proposalContext()`), sends their fields and named values to Nemotron, parses the JSON reply → `verifyProposal()`; on failure it asks once more with the failures → returns `{proposal, verification}` → the browser runs `verifyProposal()` again on its own copy of the chip data and renders the badge from that result.
5. Single-register decode and Explain: unchanged from the first version (`decode()`, `decodeToFacts()`, `verifyReply()`).

## Stack

- **TypeScript + React 19 + Vite 6**: fast single-page app with no framework server. Docs: https://react.dev, https://vite.dev
- **fast-xml-parser 5.11.2** (build-time only): parses SVD XML. https://github.com/NaturalIntelligence/fast-xml-parser
- **Vitest 3.2.7** (dev only): unit tests for the library. https://vitest.dev
- **NVIDIA API catalog (build.nvidia.com)**: OpenAI-compatible chat completions over plain `fetch`, no SDK. https://build.nvidia.com
- **Models**: a fallback list starting with `nvidia/nemotron-3-super-120b-a12b`; the free key used for the demo reaches `nvidia/nemotron-3.5-lightning-30b-a3b`. Reasoning off (`chat_template_kwargs.enable_thinking: false`), temperature 0.3 (0 on retries). Overridable with `NVIDIA_MODEL`. Chosen because the API is free for development, which keeps the public demo at zero cost.
- **Node ≥ 22.18**: runs the converter's TypeScript directly (native type stripping).
- **Data: stm32-rs patched SVDs**: ST's raw SVDs name no field values; the community-patched files add them. https://github.com/stm32-rs/stm32-rs
- **Alternate-function pin table**: hand-entered from the chip datasheets' "Alternate function mapping" tables (DS8626 for F407, DS10314 for F411, DS12110 for H743; RM0008 default pinout for F103). https://www.st.com

## Where It Runs and How Someone Tries It

- Browser app plus two Vercel Node functions (`api/explain.ts`, `api/propose.ts`). `vercel.json` bundles `public/svd/**` with both.
- Local: `npm install`, `npm run dev`, open http://localhost:5173. The Vite dev server serves both `/api/*` routes through a small plugin, so local matches production.
- `NVIDIA_API_KEY` (free, from build.nvidia.com) in `.env` (local) or Vercel project env vars (production). Without it, everything except Explain and Write works.
- Tests: `npm test`. Lint: `npm run lint`. Type check and build: `npm run build`.
- Regenerating data: `npm run svd` (reads `data/svd/*.svd`, writes `public/svd/`).
- Live: https://reglens-five.vercel.app (auto-deploys from `main`).
- Demo recording: a real Black Pill on camera, GDB dumps pasted into the deployed doctor tab; the example buttons reproduce the same dumps without hardware.

## Look and Feel

From `prd.md > Look and Feel`. CSS custom properties for both color schemes, chosen by `prefers-color-scheme`. System sans for text, system monospace for every number, register and field name. Register figure uses 1px ink rules and hatched reserved bits; amber for changed fields; red for errors and reserved-set bits. Findings are cards with a 3px left border in the severity color and field citations as monospace chips. Verified badge green, Not verified red. Max width 1100px; under 760px controls stack and tables become cards.

## Components

### SVD converter (`scripts/svd_to_json.ts`)
Parses each SVD; resolves `derivedFrom` on peripherals, clusters, registers, fields and enumerated values; expands `dim` arrays; inherits size, access and reset; dedupes enum tables. Zero unresolved references on all four chips.
PRD ref: `prd.md > Value decoding`.

### Decode library (`src/lib/decode.ts`)
`parseValue`, `decode`, `lookup`, `lookupKey`, `decodeToFacts`, formatting helpers. Pure functions shared by page and server. Arithmetic instead of 32-bit bitwise operators to avoid signed-int bugs.
PRD ref: `prd.md > Value decoding`.

### Search (`src/lib/search.ts`)
Normalizes `->`, `.`, `::` and spaces to `_`; ranks matches; supports absolute addresses.
PRD ref: `prd.md > Register lookup`.

### Dump parser (`src/lib/dump.ts`)
`parseDump(text)` recognizes GDB `x/` rows (`0xADDR <sym>: w w w`), OpenOCD `mdw` rows, `NAME = value` / `NAME: value` lines, `ADDR = value` lines, `p/x *PERIPH` struct output (with `AFR = {a, b}` → AFRL/AFRH), and `p/x NAME` followed by `$n = value`. Returns tagged words plus skipped lines with reasons. `mapDump(device, words)` resolves addresses through an index of every register address (overlapping registers such as `CCMR1_Output`/`CCMR1_Input` are chosen by the CCxS bits), masks 16-bit registers, keeps the last duplicate, and decodes each register.
PRD ref: `prd.md > Dump input`.

### Clock tree (`src/lib/clocks.ts`)
`deriveClocks(device, regs, {hseHz, overrides})` computes SYSCLK, HCLK, PCLK1, PCLK2 and both timer clocks. F407/F411: `RCC_CFGR.SWS/HPRE/PPRE1/PPRE2` and `RCC_PLLCFGR.PLLSRC/PLLM/PLLN/PLLP`, with F411 `RCC_DCKCFGR.TIMPRE`. F103: `RCC_CFGR.SWS/PLLSRC/PLLXTPRE/PLLMUL/HPRE/PPRE1/PPRE2`. Timer clock = PCLK when the APB prescaler is 1, else 2 × PCLK (RM0090 / RM0383 / RM0008 clock trees). H743: overrides only. Each clock carries its source (`rcc`, `manual`) and the fields it came from. `busOf(device, peripheral)` finds the RCC enable field (`USART2EN`, `GPIOAEN`, `IOPAEN`) and maps its register to AHB, APB1 or APB2.
PRD ref: `prd.md > Computed quantities`.

### Alternate-function table (`src/lib/afmap.ts`)
Per chip: `{pin, signal, af}` rows for common signals (USART1/2/3/6 TX/RX, SPI1, I2C1, TIM1–TIM5 channels, Discovery and Nucleo LED timers). F103 rows carry no AF number (fixed default mapping). Source datasheet named per chip.
PRD ref: `prd.md > Cross-register findings`.

### Doctor rules and math (`src/lib/doctor.ts`)
`diagnose(device, mapped, options)` returns `{clocks, findings, quantities, hints}`. Rules, each a small function with an id:
- `clock-off`: RCC enable field = 0 for a peripheral in the dump.
- `pin-mux`: F4/H7 AFR value vs the table's AF for the target peripheral's signals; F103 output signal on a general-purpose (CNF = 00/01) pin.
- `output-as-input`: ODR bit set (or pin named as output in the question) while the pin is in input mode.
- `not-enabled`: USART UE/TE/RE; TIM CEN; CCxE on a PWM channel; TIM1/TIM8 BDTR.MOE.
- `baud-error`: |error| > 2% from the target or nearest standard rate.
Math: `usartBaud()` (RM0090 "Fractional baud rate generation": baud = f_CK / (8 × (2 − OVER8) × USARTDIV); RM0433 for H7's 16-bit BRR and PRESC) and `timerPwm()` (f = f_TIM / ((PSC + 1) × (ARR + 1)) edge-aligned, / ((PSC + 1) × 2 × ARR) center-aligned; duty = CCR / (ARR + 1), inverted for PWM mode 2). `doctorFactsText()`, `findingsSummary()` and `verifyDoctorReply()` serve the Explain function.
PRD ref: `prd.md > Cross-register findings`, `prd.md > Computed quantities`, `prd.md > Explain`.

### Proposal verifier (`src/lib/propose.ts`)
`proposalContext(device, request)` picks registers from pins (`PA5` → GPIOA pin-5 fields) and peripheral names (`USART2`, plus its RCC enable register) and formats their fields and named values for the prompt. `parseProposal(text)` extracts the model's JSON. `verifyProposal(device, request, proposal)` runs the checks in `prd.md > Write a config`, including `runC()`, a tiny interpreter for `PERIPH->REG = / |= / &= expr;` with integer literals, `~ << >> | & ^ + -`, parentheses and casts; any other identifier fails the check.
PRD ref: `prd.md > Write a config`.

### Page (`src/App.tsx`, `src/components/*`)
`App` owns the route (mode, chip, mode inputs) mirrored to the URL hash and the tab bar. `DecodeView` is the original single-register screen (`RegisterSearch`, `BitfieldStrip`, `FieldTable`, `ExplainPanel`). `DoctorView` holds the paste box, clock inputs, `Findings`, computed cards and register cards. `WriteView` holds the request box and the proposal card (badge, checks, field tables, C lines).
PRD ref: `prd.md > Screens and Layout`.

### Explain function (`api/explain.ts`)
Single-register mode as before. Doctor mode when the body has `dump`: validates sizes (≤ 8,000 characters), re-runs the library, sends `doctorFactsText()` plus the optional question, verifies with `verifyDoctorReply()`, retries once at temperature 0, falls back to `findingsSummary()`.
PRD ref: `prd.md > Explain`.

### Propose function (`api/propose.ts`)
Validates `{chip, request}` (request ≤ 300 characters), builds the context, calls Nemotron for JSON, verifies, retries once with the failures, returns proposal plus verification.
PRD ref: `prd.md > Write a config`.

### Model client (`api/_nvidia.ts`)
Shared by both functions: candidate model list with 404 fallback, `chat_template_kwargs` retry, error mapping (401/403/402/429), key redaction in error text, `<think>` stripping, time budget.

## Data Model

- `public/svd/index.json`: list of chips: id, label, file, counts.
- `public/svd/<chip>.json`: `DeviceJson` (peripherals → registers → fields, shared enum tables). Types in `src/lib/types.ts`.
- Doctor and Write inputs live only in the URL hash (base64url JSON). Nothing is stored server-side.

## File Structure

```
reglens/
├── api/
│   ├── _nvidia.ts            # shared Nemotron client (not a route)
│   ├── explain.ts            # POST /api/explain: register or doctor summary, verified
│   └── propose.ts            # POST /api/propose: write-mode proposal, verified
├── data/svd/*.svd            # stm32-rs patched SVDs (source data)
├── devpost/                  # scope.md, prd.md, spec.md (+ learner-profile.md, gitignored)
├── docs/                     # internals moved out of the README
├── public/svd/*.json         # generated chip data (committed)
├── scripts/svd_to_json.ts    # SVD → JSON converter
├── src/
│   ├── App.tsx               # route state, tabs
│   ├── components/           # DecodeView, DoctorView, WriteView, Findings, ExplainPanel, ...
│   ├── lib/                  # decode, search, dump, clocks, afmap, doctor, propose, cite, share, examples
│   └── index.css             # theme tokens and layout
├── tests/*.test.ts           # Vitest unit tests
├── vite.config.ts            # React plugin + dev /api/* middleware
├── vitest.config.ts
├── vercel.json               # bundles chip JSON into the functions
├── .env.example              # NVIDIA_API_KEY, NVIDIA_MODEL (names only)
└── LICENSE                   # MIT
```

## External Services and Dependencies

- **NVIDIA API catalog chat completions**: `POST https://integrate.api.nvidia.com/v1/chat/completions` with `Authorization: Bearer $NVIDIA_API_KEY`, body `{model, messages: [system, user], temperature, top_p: 0.9, max_tokens: 1024, chat_template_kwargs: {enable_thinking: false}}`. Response: `choices[0].message.content`. Free for development under NVIDIA's API Trial Terms; rate limits set per account. Docs: https://docs.api.nvidia.com
- **Vercel** free tier hosting. No other services.

## Important Failure Modes

- **No API key or API error** → Explain and Write show a plain message; decoding and the doctor are unaffected.
- **Model proposes something wrong** → Not verified with the failed checks; one automatic retry; never shown as correct.
- **AF table has no row for a pin** → no AF claim for that pin; the finding list says which pins were checked.
- **Clock unknown** → computed cards ask for RCC registers or a typed clock instead of guessing.

## What Was Simplified and Why

- **Curated AF table** instead of every pin of every package: the common debug pins cover the demo; full tables would be generated from vendor data later.
- **Typed-in clocks on H743** instead of deriving its multi-domain clock tree: same numbers for the demo with much less code.
- **Tiny C interpreter** for the proposal's C lines instead of compiling them: integer expressions and register assignments are all a register write needs; anything else is rejected rather than trusted.
- **Four chips**, **URL state**, **one-shot AI calls**: carried over from the first version.

## Decisions and Open Issues

- Data source: stm32-rs patched SVDs, not ST originals, because ST's name no values. Credited in README and footer.
- Model: NVIDIA Nemotron on the free API (switched from Claude Opus 5.5 on Oct 22) so the public demo costs nothing.
- Diagnosis by rules, not by the AI (from the Oct 22 judge review): every finding traces to fields and a formula.
- Proposals are verified in the browser as well as on the server, so the badge never depends only on the server's word.
- Useful unknown (from the build log, not invented): which Nemotron models a free key can reach. The hosted Super model returned HTTP 404 for Alex's key; the fallback list landed on `nemotron-3.5-lightning-30b-a3b`, confirmed with three live answers on Oct 22. TODO(Alex): add the part of this approach you were least sure about, if different.
- Open: abuse protection on the API routes is input validation and size limits only; the risk is the free quota, not money.
- Open: AF table rows are hand-entered; spot-check against the datasheet before relying on a finding for a pin outside the demo.
