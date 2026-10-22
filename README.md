# RegLens

**Paste an STM32 register value from your debugger. See every bit, named from the chip's SVD.**

You're mid-debug, GDB says `GPIOA->MODER` is `0xABFFF3FF`, and a pin won't toggle. Instead of opening a 1,700-page reference manual, paste the value into RegLens: it draws the register like a datasheet figure, names every field's setting, marks what changed from reset, and warns about reserved bits. Here, MODER5 reads `00 = Input` while its neighbors are Analog. That's your stuck pin.

An optional **Explain** button asks NVIDIA Nemotron for a two-line summary. The server re-decodes the value itself and sends only the decoded fields, so the AI can explain the register but can't invent a bit.

Built for [Devpost Build With AI: Basics](https://learn-ai-basics.devpost.com/). Planning docs: [scope](devpost/scope.md), [PRD](devpost/prd.md), [spec](devpost/spec.md).

## Features

- STM32F103 (Blue Pill), F407 (Discovery), F411 (Black Pill), H743 (Nucleo)
- Register search by `GPIOA_MODER`, `gpioa->moder`, `MODER`, or address `0x40020000`
- Value input as hex, bare hex, decimal, binary, signed decimal, or GDB's `$1 = 0x...`
- Reference-manual style bitfield figure; click any bit to flip it
- Field table with named values from the SVD, and a picker to set a field by name
- Changed-from-reset markers, reserved-bits-set warnings, unlisted-value flags
- Shareable URLs: `#stm32f407/GPIOA_MODER/0xABFFF3FF`
- Light and dark themes

## Run it

Requires Node 22.18 or newer.

```bash
npm install
cp .env.example .env    # optional: add a free NVIDIA_API_KEY to enable Explain
npm run dev             # http://localhost:5173
```

Everything except Explain works without a key. Get a free key (starts with `nvapi-`) at [build.nvidia.com](https://build.nvidia.com) by opening a Nemotron model page and clicking **Get API Key**. The key is read only by `api/explain.ts` on the server and never reaches the browser.

## Deploy (Vercel)

Import the repo in Vercel (framework preset: Vite), optionally set `NVIDIA_API_KEY` in Project Settings > Environment Variables, and deploy. `vercel.json` bundles the chip data with the explain function.

## How it works

1. `scripts/svd_to_json.ts` converts each SVD to compact JSON (`npm run svd`). It resolves `derivedFrom` references, expands register and field arrays and clusters, and dedupes named-value tables. All four chips convert with zero unresolved references.
2. The page decodes values in the browser with `src/lib/decode.ts`.
3. `api/explain.ts` validates `{chip, register, value, question?}`, re-runs the same decoder, and calls NVIDIA Nemotron through NVIDIA's free OpenAI-compatible API with the decoded facts only. It tries a short list of Nemotron models and uses the first one the key can reach. Every `FIELD = 0b…` claim in the reply is checked against the decoder; a reply that misstates a value is retried once, and if it is still wrong RegLens shows the plain decoded summary instead.

## Data

Register data comes from the [stm32-rs](https://github.com/stm32-rs/stm32-rs) patched SVDs, which add named field values to ST's CMSIS-SVD files. ST's raw SVDs name no values, so they can't say that MODER = 10 means "Alternate function". See [data/svd/NOTICE.md](data/svd/NOTICE.md). Always confirm critical settings against the reference manual. Not affiliated with STMicroelectronics.

## AI disclosure

Built with AI coding assistance (Claude Code). The planning docs and code were written with Claude and reviewed by the author. The Explain feature calls NVIDIA's hosted Nemotron model at run time.

## License

MIT for RegLens's code. SVD data files keep their upstream terms.
