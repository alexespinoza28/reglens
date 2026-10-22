---
doc: spec
status: draft
---

# RegLens — Technical Spec

## How This Works, In Plain Language

RegLens has three parts.

1. **A converter script** runs once, ahead of time. It reads each chip's SVD file (an XML description of every register, field and named value) and writes a compact JSON file per chip.
2. **A web page** loads the JSON for the chosen chip. When you paste a value, a small decoding library slices it into fields and looks up each field's named meaning. All of this happens in the browser, instantly, with no server.
3. **One server function** handles the Explain button. It receives only the chip, register name and value, runs the same decoding library itself, and sends the decoded facts to NVIDIA's Nemotron model for a short explanation.

Why this shape: decoding has to be exact, so it's plain code over vendor data. The AI is a thin layer on top that can only see what the code produced. The page works fully without the AI.

## The Core Journey Through the System

PRD ref: `prd.md > The Core Journey`.

1. Page opens → `App` reads the URL hash (`#stm32f407/GPIOA_MODER/0xABFFFFFF`) → `useChipIndex` fetches `svd/index.json` → `useDevice` fetches `svd/stm32f407.json`.
2. User types in Register → `RegisterSearch` runs `search()` over an index of `PERIPH_REG` keys → user picks one → hash updates.
3. User pastes a value → `parseValue()` normalizes it → `decode()` slices fields, matches enum values, compares with reset, finds set reserved bits.
4. `BitfieldStrip` draws the figure; `FieldTable` lists fields. Clicking a bit or choosing a named value rewrites the value → step 3 reruns.
5. Explain → `ExplainPanel` POSTs `{chip, register, value, question?}` to `/api/explain` → the function loads the chip JSON from disk, re-runs `decode()`, builds `decodeToFacts()` JSON, calls Nemotron → returns `{text}` → panel shows it.

## Stack

- **TypeScript + React 19 + Vite 6** — fast single-page app with no framework server. Docs: https://react.dev, https://vite.dev
- **fast-xml-parser 5.11.2** (build-time only) — parses SVD XML. https://github.com/NaturalIntelligence/fast-xml-parser
- **NVIDIA API catalog (build.nvidia.com)** — Explain call over its OpenAI-compatible REST endpoint using plain `fetch`, no SDK. https://build.nvidia.com
- **Model: NVIDIA Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`)** with reasoning off (`chat_template_kwargs.enable_thinking: false`) and NVIDIA's recommended sampling (temperature 1.0, top_p 0.95). Overridable with `NVIDIA_MODEL`. Chosen because the API is free for development, which keeps the public demo at zero cost.
- **Node ≥ 22.18** — runs the converter's TypeScript directly (native type stripping).
- **Data: stm32-rs patched SVDs** — ST's raw SVDs name no field values; the community-patched files add them. https://github.com/stm32-rs/stm32-rs

## Where It Runs and How Someone Tries It

- Browser app plus one Vercel Node function (`api/explain.ts`). `vercel.json` bundles `public/svd/**` with the function.
- Local: `npm install`, `npm run dev`, open http://localhost:5173. The Vite dev server also serves `/api/explain` through a small plugin, so local matches production.
- `NVIDIA_API_KEY` (free, from build.nvidia.com) in `.env` (local) or Vercel project env vars (production). Without it, everything except Explain works.
- Regenerating data: `npm run svd` (reads `data/svd/*.svd`, writes `public/svd/`).
- Demo recording: the deployed URL on desktop; start from `#stm32f407/GPIOA_MODER/0xABFFF3FF`.

## Look and Feel

From `prd.md > Look and Feel`. CSS custom properties for both color schemes, chosen by `prefers-color-scheme`. System sans for text, system monospace for every number and register name. Register figure uses 1px ink rules and hatched reserved bits; amber top border for changed fields; red for reserved-set bits and unlisted values. Max width 1100px; under 760px the controls stack and the figure tightens its type.

## Components

### SVD converter (`scripts/svd_to_json.ts`)
Parses each SVD; resolves `derivedFrom` on peripherals, clusters, registers, fields and enumerated values (bare names searched in enclosing scopes, dotted paths walked through clusters); expands `dim` arrays; inherits size, access and reset; prefers `read` enum blocks; dedupes enum tables. Prints counts of anything unresolved. Current result: zero unresolved references on all four chips.
PRD ref: `prd.md > Value decoding`.

### Decode library (`src/lib/decode.ts`)
`parseValue`, `decode`, `lookup`, `decodeToFacts`, formatting helpers. Pure functions, used by both the page and the server. Uses arithmetic instead of 32-bit bitwise operators to avoid signed-int bugs.
PRD ref: `prd.md > Value decoding`.

### Search (`src/lib/search.ts`)
Normalizes `->`, `.`, `::` and spaces to `_`; ranks exact, register-name, prefix, substring, then all-tokens matches; supports absolute addresses.
PRD ref: `prd.md > Register lookup`.

### Page (`src/App.tsx`, `src/components/*`)
`App` owns the route state (chip, register, value) mirrored to the URL hash. `RegisterSearch` is an accessible combobox. `BitfieldStrip` renders 16-bit rows of field segments with clickable bits. `FieldTable` shows fields with named-value pickers. `ExplainPanel` manages the request and stale state.
PRD ref: `prd.md > Screens and Layout`, `prd.md > Exploring a fix`.

### Explain function (`api/explain.ts`)
Validates input with strict patterns, loads chip JSON from disk, re-decodes, sends decoded facts plus an optional ≤ 200-character question (framed as a description, not instructions). Strips any `<think>` reasoning block from the reply and maps HTTP errors (bad key, used-up credits, rate limit, timeout) to clear user messages.
PRD ref: `prd.md > Explain`.

## Data Model

- `public/svd/index.json` — list of chips: id, label, file, counts.
- `public/svd/<chip>.json` — `DeviceJson`: peripherals (name, base, description) → registers (name, offset, size, access, reset, description) → fields (name, lsb, width, description, enum-table index), plus a shared `enums` array of `{v, n, d}` tables. Types in `src/lib/types.ts`.
- Session state lives only in the URL hash. Nothing is stored server-side.

## File Structure

```
reglens/
├── api/explain.ts            # Vercel function: re-decode + Claude explanation
├── data/svd/*.svd            # stm32-rs patched SVDs (source data)
├── devpost/                  # scope.md, prd.md, spec.md
├── public/svd/*.json         # generated chip data (committed)
├── scripts/svd_to_json.ts    # SVD → JSON converter
├── src/
│   ├── App.tsx               # route state, layout
│   ├── components/           # RegisterSearch, BitfieldStrip, FieldTable, ExplainPanel
│   ├── lib/                  # decode, search, types, useDevice
│   └── index.css             # theme tokens and layout
├── vite.config.ts            # React plugin + dev /api/explain middleware
├── vercel.json               # bundles chip JSON into the function
├── .env.example              # NVIDIA_API_KEY, NVIDIA_MODEL (names only)
└── LICENSE                   # MIT
```

## External Services and Dependencies

- **NVIDIA API catalog chat completions**: `POST https://integrate.api.nvidia.com/v1/chat/completions` with `Authorization: Bearer $NVIDIA_API_KEY`, body `{model, messages: [system, user], temperature: 1.0, top_p: 0.95, max_tokens: 1024, chat_template_kwargs: {enable_thinking: false}}`. Response: `choices[0].message.content`. Free for development under NVIDIA's API Trial Terms; rate limits and credit amounts are set per account. Docs: https://docs.api.nvidia.com
- **Vercel** free tier hosting. No other services.

## Important Failure Modes

- **No API key or API error** → the Explain panel shows a plain message; decoding is unaffected.
- **SVD data wrong for a field** → the value shows as "not listed" rather than a guessed meaning; the SVD source is credited in the footer.
- **Phone-width layout** → the 16-column figure gets tight under ~400px; it shrinks type rather than scrolling. Only verified down to 526px so far (headless Chrome minimum); check on a real phone before recording.

## What Was Simplified and Why

- **Four chips** instead of every STM32 — each added chip is a few hundred KB and needs spot checks against its manual. Adding more is one download plus `npm run svd`.
- **One-shot Explain** instead of chat — keeps the AI grounded on one decode. A chat would need conversation state and stricter grounding.
- **URL state** instead of accounts — sharing works with zero storage.

## Decisions and Open Issues

- Data source: switched from ST's raw SVDs to stm32-rs patched SVDs after finding the raw files have zero named values. Tradeoff: community patches, not ST originals; credited in the README and footer.
- Model: switched from Claude Opus 5.5 to NVIDIA Nemotron 3 Super on Oct 22 so the public demo costs nothing. Tradeoff: free-tier rate limits, and the hosted API was not tested before the switch because no key was available.
- The skill pack was not used. These three documents were written directly from the project drafts.
- Open: abuse protection on `/api/explain` is input validation only. With the free NVIDIA key the risk is the free quota being used up, not money.
- Open: confirm phone layout on a real device.
