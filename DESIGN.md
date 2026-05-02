# Design System — ChampSuite CKD

## Product Context
- **What this is:** Internal pricing terminal for the Cards & Hobbies buyer team. Mirrors Card Kingdom's pricelist (CK direct sync) and overlays MTGJSON multi-source data (TCGplayer, Cardmarket, Cardsphere) for cross-reference.
- **Who it's for:** The buyer/pricing team. Used hours per day to make pay/sell decisions on MTG singles.
- **Space/industry:** Trading card games (MTG single-card retail). Internal tool, not customer-facing.
- **Project type:** Web app + dashboard. Server-rendered Next.js, Supabase data, Vercel-hosted.

## Aesthetic Direction
- **Direction:** Pricing terminal — Linear/Plaid restraint × Bloomberg density × MTG-aware (the cards are the product, so card photos do real visual work).
- **Decoration level:** Minimal. Typography, hairline borders, and tabular numbers carry the design. No gradients, no decorative blobs, no shadows except the modal.
- **Mood:** Confident. Trustworthy. Fast to scan. The tool feels like the source of truth, not a demo.
- **The memorable thing:** Within 3 seconds of loading, a buyer should feel "this is my pricing terminal — I trust the numbers."

## Typography

Wired via `next/font/google` in `app/layout.tsx`.

- **Display (h1, h2, h3, dashboard hero numbers):** **Fraunces** variable serif, weights 400/500/600
  - *Why:* Most pricing tools go full sans. The serif on big numbers gives the dashboard editorial weight without enterprise-SaaS vibe. SAFE everywhere else, RISK on the dashboard.
- **Body / UI / table cells:** **Inter Tight**, weights 400/500/600
  - *Why:* Tighter than Inter, reads better at the 13.5px table density we use. Conventional and good.
- **Numbers (in tables, prices, percentages):** Inter Tight with `font-variant-numeric: tabular-nums` + `font-feature-settings: 'tnum'`. Fixed-width digits keep columns aligned.
- **IDs / code / SKUs:** **JetBrains Mono**, weights 400/500
- **Loading:** Google Fonts via `next/font` — self-hosted at build time, zero CLS, no external requests at runtime.

### Scale

| Role | Size | Weight | Family |
|---|---|---|---|
| h1 | 28px / 1.2 | 600 | Fraunces |
| h2 | 20px / 1.3 | 600 | Fraunces |
| h3 | 16px / 1.3 | 600 | Fraunces |
| stat-big | 32px / 1.1 | 500 | Fraunces |
| summary-value | 22px | 500 | Fraunces |
| body | 14px / 1.5 | 400 | Inter Tight |
| table cell | 13.5px | 400 | Inter Tight |
| small / muted | 12-13px | 400 | Inter Tight |
| label (uppercase) | 11-12px | 600 | Inter Tight |

### Font blacklist (do not use)
Inter (use Inter Tight instead), Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins, system-ui as primary.

## Color

- **Approach:** Restrained, semantic. Color is rare and meaningful. The palette is mostly warm neutrals with a single accent and clear up/down semantics.
- **Background warm-white over screen-white:** the page background is `#FAFAF7` (paper), surfaces are pure white. Reduces eye strain over long sessions.

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FAFAF7` | page background |
| `--surface` | `#FFFFFF` | cards, tables, panels |
| `--surface-2` | `#F5F4EE` | alt rows, hover, panel headers |
| `--border` | `#E8E5DE` | hairline 1px |
| `--border-2` | `#D4D0C5` | inputs, emphasis |
| `--ink` | `#1A1A1A` | primary text |
| `--ink-2` | `#404040` | secondary text |
| `--muted` | `#6B6B6B` | labels, captions |
| `--muted-2` | `#9A9A9A` | placeholders, fallback typography |
| `--accent` | `#1E40AF` | links, primary CTA |
| `--accent-hover` | `#1E3A8A` | hover state |
| `--accent-soft` | `#EFF3FB` | active nav background |
| `--up` | `#B91C1C` | price went UP (bad for buyer — costs more) |
| `--down` | `#15803D` | price went DOWN (opportunity — costs less) |
| `--highlight` | `#FEF3C7` | opportunity row tint (warm yellow) |
| `--warn` | `#C2410C` | running / in-progress |
| `--warn-soft` | `#FFF1E8` | running pill background |

### Up/down inversion vs stock-market default

This is deliberate and called out in the dashboard legend. We invert:

- **Stock market:** green = up (good for holder), red = down (bad)
- **Pricing terminal:** red = up (bad for buyer — costs more), green = down (opportunity — costs less)

Buyer pays for inventory. Higher prices = worse outcome for the team. Lower prices = arbitrage. The semantic flip is correct and the dashboard legend explains it inline.

### Dark mode

Not in V1. Internal tools used 8h/day skew light. Add later as a token-only swap (the `:root` block becomes `[data-theme="dark"]`).

## Spacing

- **Base unit:** 4px
- **Density:** Comfortable. Tables tight enough to scan a long list, prices breathing enough to read at speed.
- **Scale:** `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48 · `--s-8` 64

## Layout

- **Approach:** Hybrid — grid-disciplined inside (tables, dashboard panels), one editorial moment per page (hero stat strip on the dashboard).
- **Grid:** Tables full-width inside `main`. Dashboard panels: 3-col 2fr/2fr/1fr above 1100px, 1-col below.
- **Max content width:** 1400px (room for wide tables without forcing horizontal scroll).
- **Border radius:**
  - `--r-sm` 4px — pills, buttons, table thumbnails, inputs
  - `--r-md` 6px — panels, cards, summary boxes
  - `--r-lg` 10px — modal dialog
- **Header:** sticky, white surface, hairline border-bottom.

## Card thumbnails

The signature visual element. MTG cards are visually distinctive — the photo is more recognizable than the name to a working buyer.

- **Source:** Scryfall image API (`https://cards.scryfall.io/{size}/front/{c1}/{c2}/{uuid}.jpg`)
- **Helper:** `lib/scryfall.ts` (`scryfallImageUrl`, `isValidScryfallId`)
- **Component:** `components/CardThumb.tsx` (server) — 56×78px, lazy-loaded, click-to-enlarge via data attributes
- **Enlarge:** `components/ImageEnlargeProvider.tsx` (client, mounted once in layout) — native `<dialog>` modal at 488px width, closes on Esc / backdrop / explicit button. Event delegation via `data-card-thumb="1"` so a 50-row table only adds 1 listener.
- **Fallback:** when `scryfall_id` is null or malformed (we have ~5% of these from CK's dump), render a typographic fallback: gradient background + first letter of card name in Fraunces. Never broken images.

## Motion

- **Approach:** Minimal-functional. Only transitions that aid comprehension.
- **Easing:** `ease` (default) for everything.
- **Duration:** 80ms on hover transitions (table rows, thumbnails, buttons). Fast enough to feel responsive, slow enough to read as intentional.
- **No:** scroll animations, entrance animations, parallax, sparkles.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-02 | Initial design system | Move from "browser default + a few inline styles" to a coherent pricing-terminal aesthetic. Approved A from /design-consultation. |
| 2026-05-02 | Fraunces serif on dashboard numbers | RISK choice — most pricing tools go full sans. The serif gives the tool editorial weight, helps it feel like a serious instrument vs a SaaS lookalike. |
| 2026-05-02 | Warm off-white background `#FAFAF7` | RISK choice over pure white. Better for hours-long sessions. |
| 2026-05-02 | Inverted color semantics (red=up, green=down) | Buyer-perspective: red = higher cost, green = arbitrage. Correct for the user, even though it inverts the stock-market default. Legend explains it inline on the dashboard. |
| 2026-05-02 | Scryfall thumbnails on every list/dashboard row | The cards are the product. Buyers recognize art faster than names. Click-to-enlarge for verification on rare/promo printings. |
| 2026-05-02 | No dark mode in V1 | Internal tool used light hours dominate. Build only what we use. Tokens-only architecture means dark mode is a CSS swap when needed. |
| 2026-05-02 | New `/` dashboard | Replaces "1 sentence + count + link" with a 4-stat hero, search, three panels (movers, opportunities, sync activity), and quick links. The home page is now an actionable surface. |
| 2026-05-02 | Buylist opportunity = CK buy > TCG retail | True arbitrage signal. MTGJSON has no "TCG low" series — using TCG retail (market). View `buylist_opportunities` enforces the join. |
