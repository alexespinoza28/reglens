---
doc: scope
status: draft
---

# RegLens

Paste an STM32 register name and the value you read in the debugger; see every bitfield decoded and named, with a plain-English explanation.

## The Unique Kernel

Decoding is deterministic, driven by the chip's SVD file, so every field name and value meaning comes from vendor data. The AI only explains what the decoder already established, so it can't invent a bit. Most "ask an AI about my register" flows do the reverse and hallucinate field layouts.

## Who It's For

An embedded student or firmware engineer halfway through a debug session on an STM32. They have a value like `0xABFFF3FF` from GDB and a pin that isn't doing what they expect. Today they open a 1,700-page reference manual, find the register chapter, and decode 16 two-bit fields by hand.

## The Core Loop

1. Pick the chip.
2. Type a register (`GPIOA_MODER`, `rcc->ahb1enr`, or an address).
3. Paste the value straight from GDB.
4. Read the bitfield figure and the field table. Spot the field that's wrong.
5. Optionally press Explain, or flip bits to see what the right value would be.

They come back every time a peripheral misbehaves, because it's faster than the manual.

## Inspiration & Identity

Should look like a register figure from an ST reference manual: bit numbers across the top, boxed fields, monospace values. Calm and dense rather than flashy. A debugging tool, not a chatbot.

## Why This Matters to the Learner

Alex works with STM32 parts as a part-time embedded engineer and as a Computer Engineering student. Decoding registers by hand mid-debug is a real, repeated cost. TODO(Alex): replace this paragraph with a sentence or two in your own words.

## What "Working" Looks Like

A deployed page where pasting `0xABFFF3FF` into `GPIOA_MODER` on an F407 immediately shows MODER5 = 00 (Input) while its neighbors are Analog. That's the "oh" moment: the stuck pin is configured as an input. The Explain button then says so in two sentences, citing only those fields.

## The POC Boundary

- Four common chips: STM32F103, F407, F411, H743.
- Register search by name, C-style `PERIPH->REG`, or absolute address.
- Value parsing for hex, decimal, binary, and GDB's `$1 = 0x...` output.
- Bitfield figure, field table with named values, changed-from-reset markers, reserved-bit warnings.
- Click-to-flip bits and per-field value pickers.
- One Explain call per value, grounded only on decoder output.
- Shareable URL for any decode.

## Later

- Diff mode: paste two values, highlight changed fields.
- More STM32 families (G0, G4, L4, U5) and other vendors' SVDs.
- Paste a whole GDB `x/8wx` dump of a peripheral block.
- Generate the C expression that sets a field.

## Explicitly Cut

- **Live hardware connection (SWD/OpenOCD)**: needs a native helper and drivers; out of proportion for a weekend.
- **Chat with the AI**: one grounded explanation is enough to prove the kernel. Free-form chat invites answers the decoder can't back.
- **User accounts and saved sessions**: the shareable URL covers sharing without storing anything.
- **All 1,000+ chips in the SVD collection**: data size and testing time. Four well-tested chips beat many untested ones.
