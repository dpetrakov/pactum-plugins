# Pactum brand

The public project reuses the owner's approved Pactum identity, originally consolidated on April 27, 2026. Its visual direction is **Workshop tool + Indie editorial**, also called Trinity.

## Identity

- V03 **Seal + witness dot**: a terracotta square, italic Fraunces P, cream separation ring and a witness dot at the upper-right corner.
- Upright Fraunces medium wordmark. Italic display text carries emphasis.
- Cream paper, warm ink, terracotta action marks, sage confirmations and operational monospace labels.
- Dry, warm, concrete copy. Show who decides and what happens next.

The identity supports the new project: an agent proposes an edit and the reviewer closes the round. The former product's accountability mechanics, surveys, customer claims and legal pages are outside this release.

## Reused assets and sources

The owner requested reuse from the existing private Pactum project. Public files contain only the selected brand material.

| Public artifact | Original project artifact |
|---|---|
| `site/theme.css` | `landing/src/styles.css`, Trinity light/dark tokens |
| V03 seal and wordmark styles | `landing/src/styles.css`, brand/seal rules |
| `site/assets/pactum-mark.svg` and favicon set | `docs/design-explorations/assets/favicon/` |
| Paper texture and stamp grammar | `landing/src/styles.css` |

The approved logo is the terracotta square with the witness dot above its upper-right corner and the upright Fraunces wordmark. Preserve this exact identity in both header and footer; do not substitute a circular seal, rotate it or replace its typeface.

Original SVG/PNG assets are copied without changing their artwork. The landing's social preview is rendered from the new product copy and the reused identity. The site's fonts are self-hosted; their separate licenses are listed in `THIRD_PARTY_NOTICES.md`.

`site/theme.css` is the public site's token source. Dark small text uses the original higher-contrast `ink-soft` value instead of the former muted value. Primary button backgrounds keep the original dark terracotta to retain white-label contrast. Brand colors do not replace bb's host theme tokens inside the plugin.

## Palette and type

| Role | Light | Dark |
|---|---|---|
| Paper | `#FAF8F2` | `#15151B` |
| Surface | `#FFFDFA` | `#1F1F26` |
| Ink | `#1A1814` | `#F2F2F4` |
| Soft ink | `#5A554B` | `#9CA0A8` |
| Terracotta | `#C2503D` | `#DB6E58` |
| Sage | `#5C7A5E` | `#7A9A7D` |

Display: Fraunces. Body: Inter. Labels and counters: JetBrains Mono. Keep keyboard focus, AA text contrast, touch targets, reduced motion and 390 px layouts working in both themes.
