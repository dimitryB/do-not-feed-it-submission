# Notices and asset provenance

Do Not Feed It is MIT-licensed, Copyright (c) 2026 Neva Technologies Inc
(see [LICENSE](LICENSE)).

## Code reused from Proof of Patience

Some infrastructure — the render core, the effects and post-processing layers,
the procedural textures, the audio mixer and its panel, small UI helpers, the
Workers/D1 scaffold and the signed-result registry pattern — is reused from
the author's own [Proof of Patience](https://github.com/dimitryB/proofOfPatience)
(Hemi Arcade Contest 1). Both games have the same copyright holder, so that code
is relicensed here under this project's own license and no separate upstream
notice applies. The game itself — rules, simulation, creature, lore, score,
chain rules and contract — was written for this project.

## Dependencies

Runtime and development dependencies are listed in `package.json`, with exact
versions and integrity hashes in `package-lock.json`. Their licenses and
notices stay with the packages; this project's license does not relicense them.

## Art

| Asset | Source | Terms |
| --- | --- | --- |
| `public/art/kitchen.png` — the kitchen and the creature | Original, generated for this project (OpenAI image generation, no reference images); prompts in `docs/ART_PROVENANCE.md` | Owned by the project |
| `public/art/launcher.png` — the coin launcher | Original, generated the same way | Owned by the project |
| The creature rig, mouth, mutations and effects | Drawn in code at runtime from `kitchen.png` | Owned by the project |
| The flying car | Drawn in code | Owned by the project |
| `public/og.jpg` — the social card | Composed from `kitchen.png`; the title is set in Anton (SIL Open Font License 1.1), rendered into the image — the font itself is not included | Owned by the project |
| `public/favicon.svg`, `public/apple-touch-icon.png` — the icon | Drawn for this project (the masthead's "!" mark) | Owned by the project |
| `public/art/tokens/btc.svg` — the Bitcoin mark | Wikimedia Commons, `Bitcoin.svg` | Public domain |
| `public/art/tokens/eth.svg` — the Ethereum mark | ethereum.org brand assets, via Wikimedia Commons | Used unmodified, per the ethereum.org brand guidelines |
| `public/art/tokens/hemi.svg` — the HEMI mark | Hemi brand kit | Used unmodified, per Hemi's request that the mark's look and feel not be changed |

The three token marks are drawn exactly as delivered — no recolouring, tint,
skew, squash, outline or crop. The game only draws behind and around them (a
plate, a rim, trails); see `docs/ART_PROVENANCE.md`, "How the marks are used".
The marks belong to their owners; their use here implies no endorsement.

## Sound

All music, ambience and sound effects are synthesized in the browser at run
time (`lib/engine/audio.ts`, `lib/engine/score.ts`). No recordings, samples or
third-party audio are included.

## Fonts

None are bundled. The page uses system fonts (Impact / Arial Narrow for display,
Helvetica Neue / Arial for text, the system monospace).

## Words

The short lines the creature says, and the cited verses on the title, pause and
report screens, are quotations from Hemi's public livestreams (Midweek with Max
and Engineering Office Hours, September–October 2026), each attributed with its
show, date and timestamp in [docs/QUOTES.md](docs/QUOTES.md). This is a fan-made contest entry; nothing in it implies
that Hemi made or approved it.
