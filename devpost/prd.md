---
doc: prd
status: draft
---
<!-- Generated with the Devpost Learn skill pack's 3-prd skill (challengepost/learn-ai-basics)
     from templates/prd-template.md and references/prd-guide.md on Oct 22, 2026. Interview
     answered from Alex's written plan; see RESOURCES.md > Skill pack run.
     TODO(Alex): read it and set status: approved. -->

# RegLens — Product Requirements

A one-page web tool for embedded developers bringing up an STM32 peripheral: it decodes a pasted register dump from SVD data, diagnoses cross-register mistakes with deterministic rules, computes baud and PWM numbers, and turns a plain-English setup request into register values it has verified. Source: `scope.md > The Unique Kernel`, `scope.md > Who It's For`.

## The Core Journey

1. The developer opens RegLens. Three tabs sit under the header: **Decode a register**, **Peripheral doctor**, **Write a config**. A first visit opens the decoder with an example (`GPIOA_MODER = 0xABFFFFFF` on STM32F407) so the page is never empty. Source: `scope.md > The Core Loop`.
2. They pick the chip from the Chip menu (shared by all three tabs).
3. In **Peripheral doctor** they paste what the debugger printed, or press one of the example buttons. Clocks: HSE is prefilled for the chip's common board, and APB clocks can be typed in.
4. Findings appear at once, most severe first. Each says what is wrong, why it matters, and cites the exact register fields and values.
5. Below the findings, computed numbers: USART baud rate and error, timer PWM frequency and duty, with the formula and clock used. Then the clock tree, then each decoded register with its changed fields. Any register opens in the single-register decoder.
6. Optionally they type what they're debugging and press **Explain findings**. A short summary appears, based only on the findings and decoded fields.
7. In **Write a config** they type the setup they want ("PA5 push-pull output, 50 MHz, no pull"). RegLens shows the proposed field values and a C line, each decoded from the SVD, with a Verified or Not verified badge and the list of checks.
8. They copy the URL to share the exact view.

Success: the developer finds the misconfigured register without the reference manual, and copies only register values RegLens has verified.

## Screens and Layout

One page, top to bottom:

1. Header: name, one-line purpose.
2. Tab bar: Decode a register, Peripheral doctor, Write a config. Chip menu beside the tabs.
3. **Decode a register** (existing): Register search and Value; summary; register figure; field table; Explain panel.
4. **Peripheral doctor**: paste box with example buttons; clock inputs (HSE, optional APB1/APB2 overrides) and optional target baud; then Findings, Computed, Clocks, Registers, and the Explain findings panel.
5. **Write a config**: request box with example chips; proposal card with badge, checks, field table and C lines; "Open in decoder" link per register.
6. Footer: data source and disclaimer.

Phones: controls stack vertically; tables become one card per row.

## Look and Feel

Source: `scope.md > Inspiration & Identity`. Reads like a reference-manual register figure: thin rules, boxed fields, monospace numbers. One blue accent for interactive elements; amber marks changed-from-reset; red marks errors, reserved bits set and unknown values. Findings use the same palette: red for errors, amber for warnings, grey for hints. Verified is a green badge, Not verified a red one. Follows the system light or dark setting. Copy is short and practical, written for someone mid-debug.

## Features and Behavior

### Register lookup

- As a firmware developer, I want to find a register by the name I see in code so that I don't need to translate it.
  - [ ] `GPIOA_MODER`, `gpioa->moder`, `GPIOA.MODER` and `gpioa moder` all find GPIOA_MODER.
  - [ ] Typing `0x40023830` on F407 finds RCC_AHB1ENR.
  - [ ] Cluster registers are reachable (e.g. `DMA2_ST3_CR`).

### Value decoding

- As a developer with a GDB value, I want to paste it as-is so that I don't reformat it.
  - [ ] `0xABFFF3FF`, `ABFFF3FF`, `2885678079`, `$1 = 0xabfff3ff` and `-1409289217` decode to the same value.
  - [ ] Each field shows its bit range, value and the SVD's named value; unlisted values are flagged, not guessed.
  - [ ] Changed-from-reset fields are marked; set reserved bits raise a warning naming the mask.
  - [ ] Clicking a bit or picking a named value updates the value, table and URL.
  - [ ] Old links like `#stm32f407/GPIOA_MODER/0xABFFF3FF` keep working.

### Dump input

- As a developer, I want to paste a whole dump so that I see every related register at once.
  - [ ] GDB `x/20wx 0x40020000` output (address, colon, words) maps each word to the register at that address.
  - [ ] OpenOCD `mdw` output (bare hex words) works the same way.
  - [ ] `GPIOA->MODER = 0x...`, `GPIOA_MODER: 0x...` and `0x40020000 = 0x...` lines work, mixed in one paste.
  - [ ] `p/x *GPIOA` struct output works, including `AFR = {0x0, 0x7700}` as AFRL/AFRH.
  - [ ] A `p/x GPIOA->MODER` line followed by `$1 = 0x...` is read as that register.
  - [ ] Lines that aren't register values are listed as skipped with the reason; words at addresses with no register are counted, not decoded.
  - [ ] A register pasted twice uses the last value and says so.

### Cross-register findings

- As a developer, I want RegLens to tell me which setting contradicts another so that I don't cross-check by hand.
  - [ ] **Clock off**: a peripheral in the dump whose enable bit in RCC is 0 gets an error citing that field (e.g. `RCC_AHB1ENR.GPIOCEN = 0`).
  - [ ] **Wrong alternate function**: on F4/H7, a pin in alternate-function mode whose AFR value doesn't select the peripheral being debugged gets an error naming the AF it does select and the one needed. On F103, a peripheral output pin set as a general-purpose output instead of alternate-function gets an error.
  - [ ] **Output pin left as input**: a pin with its ODR bit set, or named as an output/LED in the question, that is in input mode gets a warning.
  - [ ] **Not enabled**: USART with UE, TE or RE off; timer with CEN off; PWM channel with CCxE off; TIM1/TIM8 with MOE off. Each gets a finding citing the field.
  - [ ] **Baud out of tolerance**: actual baud more than 2% from the target (or the nearest standard rate) gets an error.
  - [ ] When a check needs a register that isn't in the dump, a hint names it and its address.
  - [ ] Every finding cites register, field, value and named meaning, exactly as the decoder produced them.

### Computed quantities

- As a developer, I want the real baud rate and PWM frequency so that I don't do the math by hand.
  - [ ] USART: BRR plus the bus clock gives the actual baud rate, the error from target, and the clock that BRR would be right for.
  - [ ] Timer: PSC, ARR, CCRx plus the timer clock give PWM frequency and duty for each channel in PWM mode.
  - [ ] Clocks come from RCC registers in the dump (F103, F407, F411), or from typed-in values, which take priority. The source of each clock is shown.
  - [ ] When a clock is unknown, the number is not guessed; the card says what to add.

### Write a config

- As a developer, I want to describe a setup in words and get register values I can trust.
  - [ ] The AI proposes field values and C lines for the request, using only registers and fields from the chip's SVD.
  - [ ] RegLens checks every proposal: the register and field exist and are writable, each value fits and is a named value, the AI's stated meaning matches the SVD name, the request's words (input/output/alternate/analog, push-pull/open-drain, pull-up/down/none) and numbers (a baud rate, or a PWM frequency and duty, at a stated clock) match the values, and the C lines, run from several start values, set exactly those fields and nothing else.
  - [ ] A passing proposal shows **Verified by the decoder** with the checks listed and a copy button for the C lines.
  - [ ] A failing proposal shows **Not verified** with each failed check; it is never presented as correct, and there is no copy button.
  - [ ] If the first proposal fails, RegLens asks the AI once more with the failures listed.
  - [ ] Without an API key, the tab says Write needs the AI and the rest of RegLens still works.

### Explain

- As a developer, I want a plain-English summary so that I can confirm my reading quickly.
  - [ ] Single register: the explanation mentions only fields and meanings present in the decode (existing).
  - [ ] Doctor: the summary covers the findings and computed numbers only; every `FIELD = value` and every number with a unit in the reply is checked against the decoder; a reply that fails is retried once, then replaced with the deterministic findings summary.
  - [ ] An optional question (≤ 200 characters) focuses the explanation.
  - [ ] If the input changes after explaining, the old explanation is marked stale.

## States and Boundaries

- **First load**: example decode shown; nothing blank.
- **Loading chip data**: "Loading … register map"; controls stay usable.
- **Empty dump**: the doctor shows the example buttons and a one-line format hint.
- **Dump with nothing recognised**: notice listing the skipped lines.
- **No findings**: "No cross-register problems found by RegLens's rules", with the list of rules that ran.
- **Unknown clock**: computed card asks for the clock instead of guessing.
- **Explain / Write loading, error, stale**: button shows progress; errors inline; stale results dim with a note.
- **No API key on the server**: Explain and Write return a clear message; decoding and the doctor still work.
- **Persistence**: none on the server. All state lives in the URL hash.

## Product Decisions

- Deterministic decoding and rules; the AI explains and proposes, never diagnoses on its own. So every finding traces to fields and a formula (`scope.md > The Unique Kernel`).
- A proposal the decoder can't verify is shown as Not verified, never as an answer. Accepted cost: some correct proposals get rejected when a check is strict.
- Alternate-function checks use a short curated pin table from the datasheets for common pins; pins outside it get no AF claim. Accepted cost: coverage over completeness.
- Clocks: typed-in values win over derived ones; H743 clocks are typed in only.
- Four chips, URL state, no accounts (carried from the first scope).
- Assumption: F103 AF checks assume no AFIO remap; the finding says so.

## What We're Building

Everything in `scope.md > The POC Boundary`: the existing decoder; the doctor (dump input, findings, computed quantities, clocks); Write a config with verification; Explain for single registers and for findings; shareable URLs; unit tests. Deployed to a public URL.

## Deferred From the POC

- **Diff mode**: useful for before/after comparisons, but not needed to prove the kernel.
- **H7 clock derivation**: the H7 clock tree spans many RCC registers; typed-in clocks cover the demo.
- **Full per-pin AF tables**: hundreds of rows per package; the curated table covers the common debug cases.

## Possible Later Enhancements

More rules (DMA, NVIC, I2C timing). More chip families and vendors. A GDB or VS Code helper that sends values to RegLens.

## Non-Goals

- No live connection to hardware: browser-only by design.
- No custom SVD upload: data quality would be unverified.
- No chat history: one grounded explanation or proposal per request.
- No accounts or analytics.

## Open Questions

- None blocking `spec.md`.
- TODO(Alex): confirm the demo story (Black Pill USART2 garbage, then a verified BRR from Write) before recording.
