---
doc: prd
status: draft
---

# RegLens — Product Requirements

A one-screen web tool for embedded developers that decodes an STM32 register value into named bitfields from SVD data, with an optional AI explanation. Source: `scope.md > The Unique Kernel`, `scope.md > Who It's For`.

## The Core Journey

1. The developer opens RegLens. It loads with an example decode (`GPIOA_MODER = 0xABFFFFFF` on STM32F407) so the page is never empty.
2. They pick their chip from the Chip menu.
3. They type in the Register box. Matches appear as they type: name, address, and description. They choose one with the mouse or arrow keys and Enter.
4. They paste the value from the debugger into the Value box. It accepts `0x...`, bare hex, decimal, binary, a negative signed int, or GDB's `$1 = 0x...` line.
5. The register figure and field table update immediately. Fields that differ from reset are marked. Reserved bits that are set raise a warning.
6. They find the field that's wrong. To explore a fix, they click bits in the figure or pick a named value from the field's menu. The value and URL update.
7. Optionally they type what they're debugging and press Explain. A short explanation appears, based only on the decoded fields.
8. They copy the URL to share the exact decode with a teammate.

Success: the developer identifies the misconfigured field without opening the reference manual.

## Screens and Layout

One page, top to bottom (`scope.md > The Core Loop`):

1. Header: name, one-line purpose.
2. Controls row: Chip, Register (search box), Value. Stacks vertically on phones.
3. Summary: register name and description; address, value, reset value (click to load it), access.
4. Register figure: 16 bits per row, bit numbers on top, one box per field, reserved bits hatched.
5. Field table: field, bits, value (binary and decimal), named meaning with a value picker, descriptions. A toggle shows only changed-from-reset fields.
6. Explain panel: optional question box, Explain button, result.
7. Footer: data source and disclaimer.

## Look and Feel

Source: `scope.md > Inspiration & Identity`. Reads like a reference-manual register figure: thin rules, boxed fields, monospace numbers, generous but not loose spacing. One blue accent for interactive elements; amber marks changed-from-reset; red marks reserved bits set and unknown values. Follows the system light or dark setting. Copy is short and practical, written for someone mid-debug.

## Features and Behavior

### Register lookup

- As a firmware developer, I want to find a register by the name I see in code so that I don't need to translate it.
  - [ ] `GPIOA_MODER`, `gpioa->moder`, `GPIOA.MODER` and `gpioa moder` all find GPIOA_MODER.
  - [ ] Typing `MODER` lists every GPIO port's MODER.
  - [ ] Typing `0x40023830` on F407 finds RCC_AHB1ENR.
  - [ ] Cluster registers are reachable (e.g. `DMA2_ST3_CR`).

### Value decoding

- As a developer with a GDB value, I want to paste it as-is so that I don't reformat it.
  - [ ] `0xABFFF3FF`, `ABFFF3FF`, `2885678079`, `$1 = 0xabfff3ff` and `-1409289217` all decode to the same value.
  - [ ] A non-number shows a clear error and keeps the last good decode off-screen rather than showing stale data.
- As a developer, I want every field named with its meaning so that I can read the register like the manual.
  - [ ] Each field shows its bit range, value, and the SVD's named value when one exists.
  - [ ] A value the SVD doesn't list is flagged, not guessed.
  - [ ] Fields that differ from the reset value are marked in both the figure and the table.
  - [ ] Set reserved bits trigger a warning naming the mask.

### Exploring a fix

- As a developer, I want to try a different setting so that I can see the value I should write.
  - [ ] Clicking a bit flips it and updates the value, table and URL.
  - [ ] Picking a named value from a field's menu rewrites only that field.
  - [ ] Clicking the reset value loads it.

### Explain

- As a developer, I want a plain-English summary so that I can confirm my reading quickly.
  - [ ] The explanation mentions only fields and meanings present in the decode.
  - [ ] An optional question (≤ 200 characters) focuses the explanation.
  - [ ] If the value changes after explaining, the old explanation is visibly marked stale.
  - [ ] If the server has no API key, the button returns a clear message and decoding still works.

## States and Boundaries

- **First load** — example decode shown; nothing blank.
- **Loading chip data** — "Loading … register map" notice; controls stay usable.
- **Unknown register** — notice saying it isn't on this chip, with a hint to search.
- **Invalid value** — red field outline and an error line; no decode shown.
- **Explain loading / error / stale** — button shows progress; errors appear inline; stale results dim with a note.
- **Persistence** — none on the server. All state lives in the URL hash, so reload and sharing restore it.

## Product Decisions

- SVD-driven deterministic decoding, AI only explains — so the AI cannot invent bits (`scope.md > The Unique Kernel`).
- Four chips covering common student and dev boards — breadth traded for tested accuracy.
- State in the URL instead of accounts — sharing without storage or sign-in.
- Assumption to confirm: the Explain step is optional; the tool must be fully useful without it.

## What We're Building

Everything in `scope.md > The POC Boundary`: chip choice, register search, flexible value parsing, the register figure, the field table with value pickers, reset and reserved-bit markers, the grounded Explain call, and shareable URLs. Deployed to a public URL.

## Deferred From the POC

- **Diff mode** — useful for before/after comparisons, but not needed to prove the kernel.
- **Peripheral block dumps** — needs address-range parsing and a multi-register view.

## Possible Later Enhancements

More chip families and vendors. A "C to set this field" snippet. A VS Code or GDB plugin that sends values straight to RegLens.

## Non-Goals

- No live connection to hardware: browser-only by design.
- No editing or uploading custom SVDs in the POC: data quality would be unverified.
- No chat history: one grounded explanation per value.
- No accounts or analytics.

## Open Questions

- None blocking `spec.md`. TODO(Alex): confirm the demo story (stuck GPIO input) before recording.
