---
doc: scope
status: draft
---
<!-- Generated with the Devpost Learn skill pack's 2-scope skill (challengepost/learn-ai-basics)
     from templates/scope-template.md on Oct 22, 2026. Interview answered from Alex's written
     plan; see RESOURCES.md > Skill pack run. TODO(Alex): read it and set status: approved. -->

# RegLens

A peripheral doctor for STM32: paste a register dump from GDB, and RegLens names every bit from the chip's SVD file, finds the cross-register mistakes, computes the real baud rate and PWM frequency, and writes verified register values from a plain-English request.

## The Unique Kernel

Every answer is checked by a deterministic decoder before you see it. The decoder, not the AI, reads the registers, runs the diagnosis rules and does the clock math; the AI explains those findings and proposes register values, and RegLens decodes each proposal and marks it verified or not verified. An IDE register view shows one peripheral's bits; RegLens reads several peripherals together and says which one contradicts another (pin muxed to the wrong alternate function, clock gated off, BRR computed for the wrong clock), with the exact fields as evidence.

## Who It's For

An embedded student or firmware engineer halfway through bringing up a peripheral on an STM32 board, for example a Black Pill whose UART prints garbage or whose PWM pin stays flat. They have GDB or OpenOCD open, or just a log someone pasted in chat. Today they read RCC, GPIO and the peripheral's registers one at a time against a 1,000-page reference manual and the datasheet's alternate-function table, and do the BRR or PSC/ARR math by hand.

## The Core Loop

1. Pick the chip.
2. Paste what the debugger printed: `x/20wx 0x40020000`, a few `GPIOA->MODER = 0x...` lines, or `p/x *USART2`.
3. Read the findings first (each cites fields and values), then the computed baud rate or PWM frequency, then the decoded registers.
4. Optionally press Explain for a short summary of the findings, or describe the intended setup ("PA5 push-pull output, no pull") and get register values plus a C line that RegLens has verified.
5. Share the link with a teammate.

They come back every time a peripheral misbehaves, because it is faster than cross-checking the manual by hand, and it works from a pasted log with no IDE.

## Inspiration & Identity

Should look like a register figure from an ST reference manual: bit numbers across the top, boxed fields, monospace values. Findings read like a short code review, each with the evidence beside it. Calm and dense rather than flashy. A debugging tool, not a chatbot. Reference: ST reference manuals RM0383 (F411) and RM0090 (F407), https://www.st.com.

## Why This Matters to the Learner

Alex works with STM32 parts as a part-time embedded engineer and as a Computer Engineering student, and decoding registers by hand mid-debug is a repeated cost.
TODO(Alex): replace this with a sentence or two in your own words (a real debug session where a register cost you time).

## What "Working" Looks Like

On a real Black Pill (STM32F411) whose USART2 prints garbage at 115200, Alex dumps RCC, GPIOA and USART2 in GDB and pastes the output into the deployed page. RegLens shows: "USART2 actual baud 359,712 (+212% from 115200); BRR 0x008B matches 115200 only at a 16 MHz clock, but APB1 runs at 50 MHz", citing `RCC_CFGR.PPRE1`, `RCC_PLLCFGR` and `USART2_BRR`. That is the "oh" moment. Then Alex types "USART2 115200 baud at 50 MHz APB1" into the write box and gets a BRR value and C line marked Verified by the decoder.

## The POC Boundary

- Four chips: STM32F103 (Blue Pill), F407 (Discovery), F411 (Black Pill), H743 (Nucleo).
- Single-register decoder (already built): search by name, `PERIPH->REG` or address; hex, decimal, binary, GDB `$1 =` values; bitfield figure, named values, reset and reserved-bit markers, click-to-flip; shareable URL.
- Peripheral doctor: paste a multi-register dump (GDB `x/Nwx`, OpenOCD `mdw`, `p/x *PERIPH`, or `NAME = value` lines), map each word to its register by address, decode all.
- Three to five deterministic cross-register rules, each citing exact fields and values: clock gated off in RCC, pin routed to the wrong alternate function, output pin left in input mode, peripheral or channel not enabled, baud rate out of tolerance.
- Computed quantities: USART baud and error from BRR and the bus clock; timer PWM frequency and duty from PSC, ARR and CCR. Clocks derived from RCC registers when they are in the dump, or typed in by hand.
- Write mode: a plain-English request becomes proposed field values plus a C line from the AI; RegLens decodes the proposal and shows Verified or Not verified before showing it.
- Explain: an AI summary of the findings, grounded only on decoder output, with the existing reply checker and decoder fallback.
- Unit tests for dump parsing, each rule, the baud and PWM math, and write-mode verification.

## Later

- More rules (DMA stream vs peripheral request, NVIC enables, I2C timing).
- H7 clock-tree derivation from RCC (manual clock entry only for now).
- AFIO remap on F103; a complete per-pin alternate-function table for every package.
- Diff mode: paste two dumps, highlight what changed.
- A GDB command that sends the current peripheral straight to RegLens.
- More STM32 families (G0, G4, L4, U5) and other vendors' SVDs.

## Explicitly Cut

- **Live hardware connection (SWD/OpenOCD from the browser)**: needs a native helper and drivers; a pasted dump covers the same need.
- **Chat with the AI**: one grounded summary and one verified proposal per request are enough to prove the kernel; free-form chat invites answers the decoder can't back.
- **User accounts and saved sessions**: the shareable URL covers sharing without storing anything.
- **All 1,000+ chips in the SVD collection**: data size and testing time. Four well-tested chips beat many untested ones.
- **Letting the AI decide what is wrong**: diagnosis stays in deterministic rules, so every finding can be traced to fields and a formula.
