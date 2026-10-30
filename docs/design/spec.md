# Teamforge redesign: design system spec

Status: v1, implementation-ready. Visual reference: `docs/design/mock.html` (open it in a browser; it uses
exactly the tokens below). Context: `docs/design/brief.md`. Mascot: `<Yeti pose="..." />` (drawn
separately; this spec only places it).

## 0. Direction in two sentences

A white "sheet" with a hand-drawn rounded top edge, on which huge tight grotesk headlines carry one
hairline serif word each, and a few big flat candy blocks do the talking instead of many pastel tiles.
The signature is **the route**: the product's real three-stage path (Идея → Разработка → Релиз) shown
as a staircase of candy blocks joined by a dashed hand-drawn line, with the pixel Yeti as the only
illustration in the system.

Rules of restraint: one serif word per headline (never two), at most two rotated elements per
viewport, at most three candy colours per screen, the mascot at most once per screen (home: three
times across the whole page, never in the same viewport).

---

## 1. Fonts

| Role | Family | Weights / axes | Cyrillic | Use |
|---|---|---|---|---|
| Sans (display + UI + body) | **Onest** | variable 400–600 used: 400, 500, 600 | yes (cyrillic, cyrillic-ext) | everything except the accent word and labels |
| Accent serif | **Noto Serif Display** | 200 and 300, normal + italic | yes | exactly one word inside a headline (`.serif`) |
| Utility mono | **Martian Mono** | 400, 500, axis `wdth` at 87.5 | yes | section marks, stage numbers, counters, commit hashes, table headers |

Why it does not read as AI-default: Onest is a Cyrillic-first Russian grotesk (Voloshin, Kudryavtsev),
not Inter/Manrope; Noto Serif Display at 200 is a hairline Didone closest to Editorial New Light,
not the ubiquitous Playfair/Cormorant; Martian Mono (Evil Martians) instead of JetBrains/Space Mono.

`src/app/layout.tsx`:

```ts
import { Onest, Noto_Serif_Display, Martian_Mono } from 'next/font/google';

const sans = Onest({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600'], variable: '--font-sans-loaded', display: 'swap' });
const serif = Noto_Serif_Display({ subsets: ['latin', 'cyrillic'], weight: ['200', '300'], style: ['normal', 'italic'], variable: '--font-serif-loaded', display: 'swap' });
const mono = Martian_Mono({ subsets: ['latin', 'cyrillic'], weight: ['400', '500'], axes: ['wdth'], variable: '--font-mono-loaded', display: 'swap' });
// <html lang="ru" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
```

Delete Inter Tight (and any other previous font import). If `axes` with explicit weights is rejected by
the installed next version, load Martian Mono with `weight: 'variable'` instead and keep `axes`.

---

## 2. Tokens (paste into the top of `globals.css`)

```css
:root {
  /* palette: literal candy, used flat, never as gradients */
  --white: #ffffff; --black: #000000;
  --pink: #ffade4; --yellow: #fff570; --blue: #0088cc; --green: #25a750;
  --brown: #ab6349; --orange: #ffa970; --red: #e95935; --grey: #f0f0f0;

  /* semantic, light */
  --bg: #ffffff;
  --surface: #ffffff;          /* cards, inputs */
  --surface-2: #f0f0f0;        /* nested cards, hovers */
  --ink: #000000;
  --muted: #5c5c5c;            /* small grey copy */
  --on-candy: #000000;         /* text on every candy fill, both themes */
  --rule: #000000;             /* structural 2px lines */
  --rule-soft: #d6d6d6;        /* row separators, 1px; decorative only */
  --danger-ink: #b8321a;       /* error text and invalid borders */
  --success-ink: #1c7a3a;
  --invalid-bg: #fff1ee;
  --disabled-bg: #f0f0f0;
  --disabled-ink: #6b6b6b;
  --focus: #000000;
  --btn-bg: #000000; --btn-ink: #ffffff;
  --btn-hover-bg: #fff570; --btn-hover-ink: #000000;
  --block-ink-bg: #000000; --block-ink-fg: #ffffff;
  --backdrop: rgb(0 0 0 / 0.55);

  /* type */
  --font-sans: var(--font-sans-loaded), system-ui, sans-serif;
  --font-serif: var(--font-serif-loaded), Georgia, serif;
  --font-mono: var(--font-mono-loaded), ui-monospace, monospace;
  --serif-weight: 200;
  --fs-hero: clamp(3rem, 1.6rem + 6.2vw, 8.25rem);     /* home h1 only */
  --fs-display: clamp(2.5rem, 1.5rem + 4vw, 5.5rem);   /* home h2, sign-in h1, 404 */
  --fs-h1: clamp(2.25rem, 1.65rem + 2.4vw, 4rem);      /* app page titles */
  --fs-h2: clamp(1.75rem, 1.4rem + 1.4vw, 2.75rem);
  --fs-h3: 1.375rem;
  --fs-lead: 1.25rem;
  --fs-body: 1.0625rem;  /* 17px */
  --fs-small: 0.9375rem; /* 15px */
  --fs-caption: 0.8125rem; /* 13px, minimum for text */
  --fs-mono: 0.75rem;    /* 12px mono labels only */

  /* spacing: 4px base */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --s7: 48px; --s8: 64px; --s9: 96px; --s10: 144px;
  --section-y: clamp(64px, 9vw, 144px);
  --gutter: clamp(16px, 4vw, 56px);
  --gap: 24px;

  /* shape: four deliberate radii, not one */
  --r-pill: 999px;   /* buttons, tags, chips, stickers, nav items */
  --r-sheet: 40px;   /* top corners of the main sheet */
  --r-card: 32px;    /* cards, candy blocks, modal */
  --r-nested: 20px;  /* nested card, alert, team-row hover */
  --r-field: 14px;   /* inputs, selects, textareas */
  --r-check: 6px;    /* checkbox */
  --bw: 2px;         /* every structural line */
  --bw-thin: 1px;    /* table and list separators */

  /* depth: no shadows anywhere. Depth = 2px rules + flat colour blocks. */

  /* motion */
  --dur-fast: 120ms; --dur: 220ms; --dur-slow: 420ms;
  --ease-out: cubic-bezier(.22, 1, .36, 1);
  --ease-spring: cubic-bezier(.34, 1.56, .64, 1);  /* arrow rotate, sticker hover */
  --marquee-dur: 42s;
}

/* dark: black page, same candy blocks with black text; not an inversion */
:root[data-theme="dark"] { /* same block also inside @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } } */
  --bg: #000000; --surface: #111111; --surface-2: #1c1c1c;
  --ink: #ffffff; --muted: #a6a6a6;
  --rule: #ffffff; --rule-soft: #333333;
  --danger-ink: #ff8a6e; --success-ink: #4cd07a; --invalid-bg: #2a0f09;
  --disabled-bg: #1c1c1c; --disabled-ink: #8a8a8a;
  --focus: #ffffff;
  --btn-bg: #ffffff; --btn-ink: #000000;   /* hover stays yellow/black */
  --block-ink-bg: #ffffff; --block-ink-fg: #000000;
  --backdrop: rgb(0 0 0 / 0.75);
  --serif-weight: 300;   /* hairlines vanish on black at 200 */
  color-scheme: dark;
}
```

### Contrast pairs (WCAG 2.x, computed)

| Pair | Ratio | Use |
|---|---|---|
| #000 on #fff | 21:1 | body, headings |
| #5c5c5c on #fff / on #f0f0f0 | 6.7 / 5.9 | muted copy, hints |
| #000 on pink #ffade4 | 12.4 | |
| #000 on yellow #fff570 | 18.5 | button hover, blocks |
| #000 on blue #0088cc | 5.4 | sign-in block, info. **Never white text on blue (3.9).** |
| #000 on green #25a750 | 6.7 | |
| #000 on orange #ffa970 | 11.2 | |
| #000 on red #e95935 | 6.0 | danger button. Red is **not** a text colour on white (3.5). |
| #000 on brown #ab6349 | 4.6 | allowed, large text preferred; #fff on brown 4.5 also passes |
| #b8321a on #fff / on #fff1ee | 6.0 / 5.5 | error text |
| #1c7a3a on #fff | 5.4 | success text |
| #6b6b6b on #f0f0f0 | 4.7 | disabled label (exceeds the requirement) |
| #fff on #000, #a6a6a6 on #000 / on #111 | 21 / 8.6 / 7.8 | dark |
| #ff8a6e on #000, #4cd07a on #000 | 9.1 / 10.6 | dark error / success |
| focus ring #000 vs #fff, #0088cc, all candy | ≥ 5.4 | non-text 3:1 met everywhere |

Rule: on any candy fill, all text is `--on-candy` (black), including muted copy (no grey on candy).

---

## 3. Type styles

| Class / element | Font | Size | Line height | Tracking | Weight |
|---|---|---|---|---|---|
| `.hero-title` (home h1) | sans | `--fs-hero` | 0.9 | -0.055em | 500 |
| `.display` (home h2, sign-in h1, 404) | sans | `--fs-display` | 0.95 | -0.05em | 500 |
| `h1` / `.page-title` | sans | `--fs-h1` | 1.0 | -0.045em | 500 |
| `h2` | sans | `--fs-h2` | 1.05 | -0.04em | 500 |
| `h3` | sans | `--fs-h3` | 1.2 | -0.02em | 600 |
| `.lead` | sans | `--fs-lead` | 1.45 | -0.01em | 400, colour `--muted` |
| body | sans | `--fs-body` | 1.55 | 0 | 400 |
| `small`, `.field-label` | sans | `--fs-small` | 1.5 | 0 | 400 / 500 |
| `.caption`, `.field-hint`, `.consent-text` | sans | `--fs-caption` | 1.5 | 0 | 400 |
| `.mono` | mono, `font-stretch: 87.5%` | `--fs-mono` | 1.4 | 0.02em | 500 |
| `.serif` (inside a heading) | serif | 1.04em | inherit | -0.02em | `var(--serif-weight)`; 300 when the heading is under 40px (marquee, h2 on phone) |

- `.serif` is upright by default; `.serif-i` adds italic (only for quotes in scallop cards and the 404).
- The serif word is a meaning word ("Выпусти", "нужны", "без", "по маршруту"), never an article or
  the brand name. One per heading. Never in body copy, buttons, nav or labels.
- Text never below 13px. Mono never above 14px (it is a label face, not a heading face).
- Use `&nbsp;` (or ` ` in i18n JSON) after one- and two-letter Russian prepositions and
  conjunctions in headings and leads (в, с, к, и, а, не, на, по, до, от, за).
- Numbers in mono use tabular figures by default (Martian is monospaced).

---

## 4. Layout

- Container: `max-width: 1440px; margin-inline: auto; padding-inline: var(--gutter)`.
- Columns: 12 columns, gap 24px at ≥1024; 8 columns, gap 20px at 768–1023; 4 columns, gap 16px below 768.
- Breakpoints: `480`, `768`, `1024`, `1280` (min-width queries; mobile first in production CSS).
- Vertical rhythm: sections `--section-y`; page head `padding-block: clamp(32px,5vw,72px) clamp(28px,4vw,48px)`;
  stacks inside a card `--s4`; between fields `28px`.

### Editorial asymmetry rules

1. **Heading left, copy right.** Page and section heads: title spans columns 1–8 (home: 1–7 or 1–10),
   supporting copy sits in columns 9–12, small grey, aligned to the **bottom** of the title
   (`align-items: end`). Below 1024 the copy drops under the title, still left-aligned.
2. **Nothing centred** except the 404 Yeti and modal titles. No centred hero, no centred section heads.
3. **Unequal pairs.** When two things sit side by side, split 7/5, 8/4 or 3/6/3, never 6/6. The
   existing `grid-2` becomes 7/5 (see §5).
4. **Staircase, not grid,** for sequences: items step right by 3 columns each (route, stage list on
   desktop). Lists of peers (teams, offers, reviews) are **rows**, not card grids.
5. **Bleed one thing per screen.** At most one element breaks the container (marquee, or a candy block
   that touches the viewport edge on phones).
6. **Rotation budget:** at most two rotated elements per viewport, between -6° and +4°; text-heavy
   cards never rotate more than 3°.
7. **Numbers only for sequences:** route stages ("этап 2 из 3"), trial-period days, counts. No
   decorative 01/02/03.

### The sheet

`main` is a white sheet: `border-top: 2px solid var(--rule)`, top corners `--r-sheet`, the side lines
visible only along the corner arcs (see `.sheet` in the mock: side `box-shadow` masked below 60px by
`::after`). It starts directly under the nav row. In dark theme the sheet line is white.

---

## 5. Shared component classes (restyle; names unchanged)

Universal focus: `:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }`. Inputs use
offset 2px (the 2px border plus gap plus 3px ring reads as a double rule; intended). Never remove focus.

Universal tap target: every interactive element has a min block size of 44px (nav items 40px tall with
a 2px row gap and 4px horizontal padding of the hit area via `::after`/padding to reach 44).

### `.button`
- Base: pill, `min-height: 52px`, `padding: 0 26px`, `border: 2px solid var(--btn-bg)`,
  `background: var(--btn-bg)`, `color: var(--btn-ink)`, Onest 500 16px, tracking -0.01em, gap 10px for an icon.
- Hover: background `--btn-hover-bg` (yellow), text black, border `--ink`. Transition `--dur` `--ease-out`.
- Active: `transform: translateY(1px) scale(.985)`.
- Focus: universal ring.
- Disabled (`[disabled]`, `[aria-disabled=true]`): `--disabled-bg`, `--disabled-ink`, **dashed** 2px border, `cursor: not-allowed`, no hover change.
- Loading (`[aria-busy=true]`): keep width, show `.spinner` before the label, label changes to the
  progressive form only if the i18n string exists ("Сохраняем…"); otherwise keep the label. Not clickable.
- `.button-secondary`: transparent, ink text, ink border; hover `--surface-2` fill (in light #f0f0f0).
- `.button-danger`: red fill, black text, red border; hover black fill with red text. Use only for
  destructive actions, never as a primary call to action.
- `.button-block`: `width: 100%`.
- Small variant (new): `.button-small`: `min-height: 44px; padding: 0 18px; font-size: 15px`, used in rows and tables.

### `.icon-button`
44px circle, 2px ink border, surface fill, ink icon (custom 20px SVG, stroke 2). Hover yellow fill,
active scale .94 with `--ease-spring`. Always has `aria-label`. Filled variant `.icon-button-ink`
(black fill, white icon) used as the round arrow companion.

### `.card` / `.card.nested`
- `.card`: surface, 2px `--rule` border, radius `--r-card`, padding `clamp(20px, 3vw, 36px)`. No shadow.
  Interactive card (`a.card`, `.card[data-interactive]`): hover background `--surface-2`, the
  trailing round arrow rotates -45°.
- `.card.nested`: `--surface-2` fill, 1px `--rule-soft` border, radius `--r-nested`, padding 20px.
- Do not put a `.card` on a candy block; use `.card.nested` there or nothing.

### Layout helpers
- `.stack`: flex column, gap `--s4`. Modifiers (new): `.stack-tight` (8px), `.stack-loose` (32px).
- `.row`: flex, wrap, centre aligned, gap 12px.
- `.page-narrow`: `max-width: 46rem` (736px), **left aligned** (`margin-inline: 0`), starts at column 1;
  the right columns stay empty or hold a `.page-aside`.
- `.page-wide`: full container width.
- `.grid-2`: 12-col grid, first child spans 7, second spans 5 (`.grid-2.flip` = 5/7). Single column below 1024.
- `.divider`: 2px `--rule` line, margin-block 32px. With text content (`.divider` containing text) it
  renders "rule · text · rule" as in sign-in.
- `.muted`: `color: var(--muted)`. Never on candy.
- `.lead`: see type table; max 52ch.
- `.sr-only`: unchanged.
- `.pre-text`: `white-space: pre-wrap`, body size; inside cards 15px.

### `.tag`, `.tag-list`
- `.tag-list`: flex wrap, gap 6px, no bullets.
- `.tag`: non-interactive pill, 28px tall, 1.5px ink border, 13px Onest 500, padding 0 12px.
- `.tag-fill` (new): ink fill, `--bg` text (selected / own role).
- Stage tags use `.stage-pill` (new, below), not candy tags.

### `.alert` (+ `-error | -warn | -success | -info`)
- Base: surface fill, 2px ink border, radius 18px, padding 14px 18px, 15px text, grid `14px 1fr`, a
  14px square marker (`::before`) filled with the variant colour and outlined in ink. First sentence in
  `<b>` (600) states what happened; the second says what to do.
- `-error`: border `--danger-ink`, background `--invalid-bg`, marker red. Keeps `role="alert"`.
- `-warn` marker orange, `-success` marker green, `-info` marker blue.
- Why not candy fills: four fully coloured alerts on one form looked like confetti; colour blocks are
  reserved for content.

### Form: `.field`, `.field-label`, `.field-hint`, `.field-error`, inputs
- `.field`: grid, gap 8px; fields are separated by 28px.
- `.field-label`: 15px, 500. Optional marker: `<span class="opt">· необязательно</span>` in `--muted`, 400.
- Inputs (`.field input`, `select`, `textarea`; also `.input`): min-height 52px, padding 0 18px, 2px ink
  border, radius `--r-field`, surface fill, 17px.
  - Hover: `--surface-2` fill.
  - Focus: ring 3px `--focus` offset 2px; fill back to surface.
  - Invalid (`aria-invalid="true"`): border `--danger-ink`, fill `--invalid-bg`.
  - Disabled: `--disabled-bg`, `--disabled-ink`, dashed border.
  - Read-only: surface-2 fill, solid border, no hover.
  - Placeholder: `--muted`.
  - `textarea`: padding 14px 18px, min-height 120px, vertical resize.
  - `select`: custom chevron made of two `linear-gradient`s (no data URI; CSP), padding-right 48px.
  - File input (resume): visually a `.button-secondary` label "Загрузить PDF" + file name in `.mono`.
- `.field-hint`: 13px muted, linked via `aria-describedby`.
- `.field-error`: 13px 500 `--danger-ink`, preceded by a 10px solid square (pixel mark, `::before`).
  Copy says what is wrong and how to fix ("В нике не может быть пробелов. Пример: masha-kov").
- `.checkbox`: label row, min-height 44px; the input is `appearance: none` 22px square, 2px ink border,
  radius `--r-check`; checked = ink fill with a `--bg` tick drawn by borders; focus ring on the input.
- `.check-grid`: `grid-template-columns: repeat(auto-fill, minmax(180px, 1fr))`, gap 0 16px.
- `.consent-text`: 13px muted, links underlined ink.

### Chips / pickers (new: `.chip`, `.pick`)
- `.chip`: interactive pill toggle, 44px (40px inside `.pick`), 2px ink border, 15px 500,
  `aria-pressed`. Pressed: ink fill, `--bg` text; inside `.pick` the pressed chip also shows an 8px
  yellow square before the label (pixel mark).
- Used for: stack picker, role preferences (with order number in mono: "1 · Фронтенд"), team filters.

### `.data-table`, `.table-scroll`
- `.table-scroll`: `overflow-x: auto`, a 2px ink top rule, keyboard focusable (`tabindex=0` already
  present stays).
- `.data-table`: full width, `border-collapse: collapse`. `th`: mono 12px, lowercase, muted,
  left-aligned, padding 12px 16px 10px, 2px ink bottom border. `td`: 15px, padding 16px, 1px
  `--rule-soft` bottom border. Row hover: `--surface-2`. Numeric columns right-aligned, mono.
  Status cells use `.stage-pill` or `.tag`.

### `.definition-list`
Grid `minmax(140px, 1fr) 3fr` at ≥768; `dt` 15px muted, `dd` 17px ink, each pair separated by 1px
`--rule-soft`; first pair has the 2px ink rule. Phone: dt above dd.

### `.plain-list`
No bullets, items separated by 1px `--rule-soft`, padding-block 14px. Used for events and feeds.

### `.award-list` / `.award`
- `.award-list`: flex wrap, gap 20px.
- `.award`: 120px circle, candy fill (cycle pink, yellow, green, orange per index), 2px black border,
  black text, centred 13px 600 label up to 3 lines, rotated per index (-6°, 3°, -2°, 5°). Below the
  circle a 13px muted date. Locked/not yet earned: dashed border, `--surface-2` fill, `--disabled-ink`
  label, no rotation. Hover on earned: rotate to 0 with `--ease-spring`.

### `.modal`, `.modal-backdrop`
- Backdrop: `--backdrop`, no blur.
- Modal: surface, 2px rule border, radius `--r-card`, max-width 560px, padding 32px, title `h2`
  `--fs-h2`. Close is an `.icon-button` top right. Actions row right-aligned: secondary then primary.
  Enter: opacity 0→1 and translateY(12px)→0 over `--dur` `--ease-out`; reduced motion: opacity only.
- Phone: a bottom sheet (radius on top corners only, full width, max-height 90dvh, scroll inside).

### `.bell-*`
- `.bell-button`: `.icon-button` with a custom bell SVG.
- `.bell-badge`: pink pill, min 22px, 2px ink border, mono 11px count, top -6px right -8px. Hidden at 0.
- `.bell-panel`: popover 380px wide, surface, 2px rule border, radius `--r-nested`, top 8px below the
  button, aligned right. Header row: "Уведомления" h3 + text button "Прочитать все".
- `.bell-item`: padding 14px 16px, 1px `--rule-soft` separators; unread items have an 8px pink square
  before the text and 500 weight; time in mono 12px muted. Empty: `<Yeti pose="sleep" />` 64px +
  "Новых уведомлений нет".
- Phone: the panel becomes a full-width sheet under the header.

### `.spinner`
Pixel spinner: 3×3 grid of 4px squares (2px gap), the eight outer squares light up in sequence (900ms,
`steps(1)`), centre square hidden. `currentColor`. Reduced motion: static, all squares at 100%
opacity except centre. Big loading states use `<Yeti pose="think" />` with the spinner beside it.

### `.pref-*` (notification and matching preferences)
- `.pref-list`: definition-like rows, each `.pref-row` a grid `1fr auto`, 1px `--rule-soft` separator.
- `.pref-label` 17px 500, `.pref-hint` 13px muted under it.
- `.pref-toggle`: switch 52×30, 2px ink border, pill; knob 20px ink square with radius 6px (squarish,
  pixel nod); on = green fill with black knob moved right. Role `switch` stays as is.

### `.icon-button`, `.sr-only`, `.divider`: see above.

---

## 6. New classes

| Class | What | Spec |
|---|---|---|
| `.sheet` | main content sheet | §4 |
| `.display`, `.hero-title`, `.serif`, `.serif-i`, `.mono` | type | §3 |
| `.section-mark` | "/// label" eyebrow | mono 12px 500, lowercase, `::before` content `"///"` with -0.08em tracking; marks a **section topic**, never numbers |
| `.sticker` (+ `-pink -yellow -green -orange -blue`) | rotated pill label | padding 8px 16px, 2px black border, Onest 600 15px black, `transform: rotate(var(--tilt, -4deg))`; decorative ones are `aria-hidden`; hover (if interactive) rotate to 0 with spring |
| `.oval` | hand-drawn oval around one word | `position: relative`; `::before` inset `-.06em -.22em -.02em`, 2px currentColor border, `border-radius: 50%`, `rotate(-4deg)`; use on dates and counts only ("с 2026", "3 места") |
| `.scallop` | wavy-edged card | flat candy fill, no border, `--r: 13px`, padding `calc(var(--r) * 2.6)`; edge via CSS mask: `radial-gradient(circle var(--r) at var(--r) var(--r), #000 98%, #0000 101%) 0 0 / calc(2*var(--r)) calc(2*var(--r)) round, linear-gradient(#000 0 0) var(--r) var(--r) / calc(100% - 2*var(--r)) calc(100% - 2*var(--r)) no-repeat` (+ `-webkit-mask`). Pure gradients, no `url()` (CSP). Rotated 2–3°. Uses: award notes, review quotes, the "про награды" note |
| `.block` (+ `-yellow -pink -blue -green -orange -grey -ink`) | candy content block | radius `--r-card`, padding `clamp(24px, 4vw, 56px)`, black text; `-ink` is black/white in light and white/black in dark |
| `.marquee`, `.marquee-track` | scrolling strip | yellow, 2px black top and bottom, `rotate(-1.6deg)`, bleeds 3vw each side; track contains the list twice, `translateX(-50%)` over `--marquee-dur` linear infinite; `aria-hidden="true"` (content duplicated in DOM text elsewhere); pauses on hover; reduced motion: no animation, list static |
| `.cta-pair` | pill + round arrow | `.button` + 52px circle `.arrow` (same fill), gap 6px; hover: both turn yellow, arrow rotates -45° with spring. The link wraps both; one accessible name |
| `.text-link` | inline action | 500, underline 2px offset .25em, min-height 44px; hover underline turns pink |
| `.chip`, `.pick` | toggles | §5 |
| `.stage-pill` | route stage label | mono 11px, padding 6px 10px, 1.5px black border, black text; fill by stage: идея yellow, разработка blue, релиз green, завершён black fill with white text |
| `.seat-grid` | team seats | row of 18px squares, 2px currentColor border; taken = filled; with mono caption "3 из 4 мест заняты" (text carries the meaning, squares `aria-hidden`) |
| `.connector` | dashed route line | 3px dashed ink, elbow with 36px radius, arrow head by borders; phone: straight vertical |
| `.checks` | stage checklist (read-only look) | rows with 1.5px currentColor top rule, 18px square box, done = filled with inset ring of the block colour |
| `.page-head`, `.page-aside` | app page header | §4 rule 1 |
| `.team-list`, `.team-row` | list of teams | §8 Teams |
| `.empty` | empty state | 2px dashed ink border, radius `--r-card`, padding 32px, grid `auto 1fr`: Yeti 96px + h3 + one muted sentence + actions |
| `.menu-toggle`, `.nav-sheet` | phone nav | §7 |
| `.footer` | site footer | §7 |
| `.button-small`, `.icon-button-ink`, `.tag-fill`, `.stack-tight`, `.stack-loose` | modifiers | §5 |

---

## 7. Shell

Structure stays: skip link, `header.shell-header`, `ShellNav` (`<nav aria-label="Основная навигация">`
with the toggle and `#shell-nav-list`), `NotificationBell`, `AccountMenu`, `main#main`. Only the
markup order and CSS change.

**Desktop and tablet (≥768): two rows.**
- Row 1, 76px: brand lockup left (Yeti head sprite 36px, `<Yeti pose="idle" size={36} />`, then
  "Teamforge" in Onest 600 22px, tracking -0.045em); right side: bell `.icon-button`, account pill.
- Row 2: the nav as a row of text pills directly above the sheet edge (40px items, 15px 500, gap 4px,
  bottom padding 14px). Hover: grey fill. Current (`aria-current="page"`): ink fill, `--bg` text. All
  8 items always visible; on 768–1023 the row may wrap to two lines, which is acceptable; if the
  product adds items later, it becomes horizontally scrollable with a 24px fade on the right edge.
- Account pill: 44px pill, 2px ink border, 32px orange avatar circle with the first letter (600), name
  15px 500. Opens the existing menu as a popover like `.bell-panel`. Signed out: replaced by
  `.button.button-small` "Войти".
- Header is not sticky (the sheet edge is the identity; a sticky bar would cut it). On scroll past 400px
  nothing appears; keep it simple.

**Phone (<768): one row + sheet.**
- Row: brand (Yeti 32px + wordmark), spacer, bell, avatar-only account button (name `sr-only`), then the
  black "Меню" pill (`.menu-toggle`, 44px, ink fill, label "Меню" + two-line icon that becomes ×).
  Put "Меню" on its own row under the brand if the row would be under 320px wide.
- Open state (`data-open="true"`): `#shell-nav-list` shows as a full-width panel directly under the
  header: surface fill, 2px rule bottom, items 56px tall, Onest 500 28px, tracking -0.03em, separated by
  1px `--rule-soft`; current item gets a yellow 12px square before the label. `<Yeti pose="wave" />`
  72px sits at the bottom right of the panel. Escape and outside click close it (already implemented).
  Focus moves to the first link on open and back to the toggle on close.

**Footer (new, all pages).** 2px rule top, padding 28px 0 40px. Left: `<Yeti pose="sleep" />` 72px +
one muted line "Teamforge — бесплатно, для студентов и джунов из России и СНГ." Right: text links
Команды, Спрос на роли, Отзывы, and legal links that already exist (do not invent pages). Phone: stacked.

---

## 8. Screens

Each app page opens with `.page-head` (h1 left in columns 1–8, one serif word allowed; aside in 9–12
with a muted sentence and at most one primary action).

**Home.** See §9.

**Sign-in.** 12-col split 7/5. Left: `.block-blue` 560px tall: display h1 "Вход <serif>без</serif>
пароля", bottom row with a 500-weight sentence and `<Yeti pose="wave" />` 152px at bottom right.
Right column, vertically centred: `.section-mark` "вход и регистрация", h2 "Привет! Как войдёшь?",
`.button.button-block` with GitHub mark "Войти через GitHub", `.divider` "или по почте", email field
with hint, `.button-secondary.button-block` "Получить ссылку", `.consent-text`. After sending: the form
is replaced by `.alert-success` + "Отправить ещё раз" text-link with a 60s countdown in mono. GitHub
error: `.alert-error` above the GitHub button. Phone: blue block shrinks to a banner (h1 + Yeti 88px), form below.
Existing control texts stay as they are in i18n.

**Profile (long form).** Three-column form layout 3/6/3: left column holds a sticky `.section-mark` +
h3 legend per group ("о себе", "роли", "опыт", "резюме"), centre column the fields, right column hints
and alerts (`.alert-info` about resume privacy). Stack picker = `.pick` of chips with "+ Добавить"
opening a search input. Role preferences = ordered chips with mono numbers "1 ·", reorder by up/down
`.icon-button`s (keyboard friendly; no drag only). Resume: `.card.nested` with file name in mono, size,
"Заменить" secondary and "Удалить резюме" danger small. Save bar: 2px rule, primary "Сохранить
профиль", loading state with spinner. Error summary `.alert-error` at the top, focused on submit
failure. Yeti: none (forms stay quiet).

**Teams list + filters.** `.page-head` "Команды, которым <serif>нужны</serif> люди" + aside with
"Создать команду" `.cta-pair` (plus icon in the circle). Filters row: 2px rule top, role chips, a
separator, stage select as a chip with chevron, mono count right ("14 команд"). Phone: filters row
scrolls horizontally, count hidden. List: `.team-list` rows (not cards): name 28px 500 + `.stage-pill`;
muted one-line pitch; `.seat-grid` with mono caption; open-role `.tag`s; round arrow `.icon-button`.
Whole row is one link (name link with `::after` overlay). Hover/focus-within: row fills pink, radius
24px, arrow inverts to black with pink icon. Empty: `.empty` with `<Yeti pose="sleep" />`, "Под эти
фильтры команд нет", reset + create actions. Loading: three skeleton rows (grey `--surface-2` bars,
no shimmer) + spinner in the count slot.

**Team detail.** Head: h1 team name, `.stage-pill`, muted pitch; aside: primary action relevant to the
viewer (Откликнуться / Покинуть команду / Управлять). Body `grid-2` 7/5: left = "Места" as rows (role,
person or "свободно" with dashed 2px outline row, trial-period badge as `.sticker-orange` "проба: 9
дней" small, not rotated in rows), then "События" `.plain-list` with mono dates. Right = `.block-yellow`
current stage card with `.checks` progress and a link to the route; below it the GitHub repo
`.card.nested` (repo name mono). Yeti: none unless the team is complete (then celebrate, see Completion).

**Create team.** `page-narrow` form, left aligned; aside column shows a live preview `team-row` of what
the team will look like in the list (this is the useful moment). Fields: name, pitch (textarea,
140-character counter in mono), roles needed as `.pick` with seat counts (stepper of two
`.icon-button`s + mono number), repo URL optional. Primary "Создать команду".

**Search / Demand (matching).** Two related screens, same pattern. Search ("Поиск команды"): the
user's queue status first, as a `.block-blue` strip: "Ты в очереди на <b>Фронтенд</b> · 4-я
позиция" in 500 weight with `.oval` around the position number, plus "Изменить роли" secondary. Below
it, matching teams in `.team-list`. Demand ("Спрос на роли"): `.page-head` "Кого <serif>не хватает</serif>
командам"; a horizontal bar list: each role a row with its name 22px, a solid black bar whose length
is the share of open seats (pure CSS width %, 12px tall, square ends), mono numbers "38 мест · 12 в
очереди". No pie charts. Waiting state uses `<Yeti pose="think" />` beside the queue block.

**Offers ("Мои предложения").** Rows, not cards: each offer a `.card` with team name, role tag, mono
deadline with `.oval` ("ответить до 3 ноября"), actions "Принять" primary and "Отказаться"
secondary. Accepted/declined history below in a muted `.plain-list`. Empty: `.empty` + `<Yeti
pose="sleep" />` "Предложений пока нет. Они придут, когда в команде откроется место под твою роль."
+ link to role preferences.

**Route of stages + stage checklist.** The signature at full size. Route page: staircase of three
`.block`s (yellow, blue, green) with `.connector`s, current stage marked by a `.sticker-pink` "вы
здесь" on its top edge, done stages show a black check square in the header and a muted progress
"3 из 3". Stage page: `grid-2` 7/5: left = the checklist as large interactive `.checkbox` rows (22px
text, 2px separators), each item can expand a muted hint; right = `.block` in the stage colour with
stage goals and "Перейти к следующему этапу" (disabled until all required items are done, with a hint
saying how many are left). Yeti: `think` while saving, nothing otherwise.

**Feed (GitHub contribution log).** A log, so it looks like one: `.plain-list` with mono rows: date
column (mono 12px muted), author avatar circle 24px, commit message 15px ink, short hash in mono with
`--surface-2` pill, repo name muted. Grouped by day with `.section-mark` "сегодня", "вчера", "28
октября". No charts, no counts per person (no comparisons). Empty: Yeti sleep + "Коммитов пока нет.
Подключи репозиторий в настройках команды."

**Votes.** Each vote a `.card`: question as h3, options as large full-width `.chip`-like radio rows
(52px, radius `--r-field`), selected = ink fill. Result after voting: each option a row with a black
bar (same pattern as Demand) and mono count. Deadline in mono with `.oval`.

**Completion and credit (awards).** The one loud screen. `.block-green` full width: display h1
"Проект <serif>выпущен</serif>", `<Yeti pose="celebrate" />` 200px at the right, two stickers
("релиз", date). Below: "Награды" h2 + `.award-list` (rotated candy circles), then a `.scallop`
pink note quoting the team's retrospective line if present. Credit list as `.definition-list` (person →
role). Celebration motion: stickers drop in with spring once, 420ms, not looping; none under reduced motion.

**Reviews ("Отзывы").** Masonry is out; use two unequal columns (7/5) of `.scallop` cards alternating
pink/yellow/orange, rotated -2°/+2°, with the quote in 17px and author in mono. Max two rotated cards
per viewport (alternate rotated and straight). Form to leave a review is a `.card` at the top of the
right column.

**Admin fraud queue.** Strict and calm, no mascot, no candy blocks: `.page-head` "Проверка", filter
chips, `.table-scroll` + `.data-table` (user, signal in `.tag`, score as mono number, date, actions
`.button-small` "Подтвердить" / `.button-danger.button-small` "Заблокировать"). Destructive actions go
through `.modal` with a required reason textarea.

**404.** Centred exception: `<Yeti pose="sad" />` 200px, display "Такой страницы <serif-i>нет</serif-i>",
muted line "Возможно, ссылка устарела или в адресе опечатка.", `.cta-pair` "На главную". A
`.sticker-yellow` "404" rotated -6° on the Yeti's corner.

Global states: loading pages use `<Yeti pose="think" />` 96px + spinner + mono "загружаем…" left
aligned in the page head area; server error uses `<Yeti pose="sad" />` + `.alert-error` with a retry
button.

---

## 9. Home, section by section (real copy)

Keys: keep `home.heroCta` ("Найти команду") and `home.nav`. Replace other `home.*` values; new keys
listed per section. `heading` stays "Teamforge" for the document title if tests use it.

**9.1 Hero** (`.hero`, 12-col). Two `.sticker`s top right of the sheet, overlapping its edge on
phone: "бесплатно" (pink, -6°), "без рейтингов" (green, +4°), `aria-hidden`.
- h1 `.hero-title` cols 1–10: "Собери команду. Пройди маршрут. <serif>Выпусти</serif> продукт."
  (`home.heroTitle`, serif word `home.heroTitleAccent`).
- Left bottom cols 1–6: `<Yeti pose="wave" />` 132px with a speech bubble (2px ink border, radius
  22/22/22/4) "Привет! Я Йети, буду рядом на каждом этапе." (`home.yetiHello`).
- Right cols 8–12: lead (muted, 20px) "Бесплатная площадка для студентов и джунов. Заполняешь профиль,
  встаёшь в очередь в команду и доводишь проект от идеи до релиза по готовому маршруту."
  (`home.lead`); `.cta-pair` "Найти команду" → /search; `.text-link` "Сначала заполнить профиль" →
  /profile (`home.heroSecondary`).

**9.2 Marquee** (bleeds, yellow, -1.6°): "Фронтенд + Бэкенд + <serif>Дизайн</serif> + Тестирование
+ Аналитика + <serif>Мобильная</serif> разработка + DevOps + Продакт +", separator = 18px pixel plus
SVG. Content from the roles dictionary if it exists, else `home.marqueeRoles`.

**9.3 Route** (`/// маршрут`).
- h2 "Три этапа, <serif>один</serif> релиз"; right note: "У каждого этапа свой чек-лист. Команда
  отмечает пункты, а коммиты из GitHub сами попадают в журнал вкладов, так что видно, кто что сделал."
- Staircase: Идея (yellow, cols 1–6, "этап 1 из 3", "~2 недели": "Проблема в одном предложении", "Три
  разговора с будущими пользователями", "Список функций для первой версии"); Разработка (blue, cols
  4–9, "~6 недель": "Репозиторий подключён к GitHub", "Задачи разобраны по ролям", "Демо команде раз в
  неделю"); Релиз (green, cols 7–12, "~2 недели": "Продукт открывается по ссылке", "README и
  скриншоты", "Ретроспектива команды"). `<Yeti pose="celebrate" />` 104px stands on the top edge of
  the Релиз block. Durations are examples; replace with real stage data if the route config has them,
  otherwise drop the duration labels rather than invent.

**9.4 How to join** (`/// как попасть в команду`). Cols 1–5 sticky: h2 "Команду не нужно
<serif>искать</serif> вслепую". Cols 7–12, rows with 2px rules:
- "Очередь по ролям": "Отмечаешь роли в порядке приоритета: например, сначала фронтенд, потом
  тестирование. Место в очереди видно в профиле."
- "Автоподбор": "Когда в команде освобождается место под твою роль, приходит предложение. Принять или
  отказаться можно в «Моих предложениях»."
- "Пробный период": "Первые две недели — проба для обеих сторон. Не сработались: спокойно расходитесь,
  без штрафов и отметок в профиле." (Confirm the trial length and the "no marks" claim with product.)

**9.5 Honest block** (`.block-ink`, cols 1–8 statement + cols 9–12 scallop). Statement 52px max:
"Здесь нет рейтингов, уровней и таблиц лидеров. Мы не сравниваем людей — только помогаем
<serif>дойти</serif> до релиза." Pink `.scallop` rotated 3°, mono "про награды": "Награды здесь
косметические: значок в профиле за пройденный маршрут. Они ничего не дают и ничего не отнимают."

**9.6 Final CTA** (`.block-yellow`): h2 "Начни с профиля. Остальное — <serif>по маршруту</serif>."
(two-word serif phrase is the one allowed exception, it is one idea), `.cta-pair` "Заполнить профиль"
bottom right. Signed-in users with a complete profile see "Открыть маршрут" instead.

**9.7 Footer** with `<Yeti pose="sleep" />`.

Phone order: stickers, h1, lead, CTA, Yeti + bubble (Yeti moves below the CTA), marquee, route
(vertical, straight connectors), join, honest (scallop below statement, right aligned, max 420px),
CTA, footer.

---

## 10. Motion

- Default transitions: colour and background `--dur` `--ease-out`; press feedback `--dur-fast`.
- Spring only on: `.cta-pair` arrow rotate, `.icon-button` press, sticker/award hover.
- One orchestrated moment: home hero on first load: h1 lines rise 16px and fade in, staggered 60ms,
  then stickers drop in with spring (420ms total). Nothing else animates on scroll.
- Marquee: 42s linear, pauses on hover and when the tab is hidden.
- `@media (prefers-reduced-motion: reduce)`: no transforms, no marquee, no stagger; colour transitions
  stay at 0ms. Spinner becomes static.

---

## 11. AI tells we avoided

- [x] No Inter / Manrope / Poppins / Inter Tight; no Playfair or Cormorant either. Onest + Noto Serif
      Display 200 + Martian Mono.
- [x] No gradients as colour (gradients exist only as invisible masks and the select chevron).
- [x] No glassmorphism, no backdrop blur, no shadows at all.
- [x] No centred hero, no two equal buttons: left-aligned headline, one pill+arrow and one text link.
- [x] No three equal icon feature cards: a staircase of unequal stage blocks and a ruled list.
- [x] No emoji in UI; separators and marks are custom SVG/CSS pixels.
- [x] A deliberate radius ladder (pill, 40, 32, 20, 14, 6) mapped to roles, not one radius everywhere.
- [x] Asymmetric grid with stated rules (7/5, 8/4, 3/6/3, staircase), no 50/50.
- [x] Real Russian microcopy that names what the product does (очередь, автоподбор, пробный период,
      чек-лист); no "раскрой потенциал".
- [x] A few strong blocks per screen (max three candy colours), not a pastel tile wall.
- [x] No Lucide icon soup: about eight custom 20px icons (bell, arrow, plus, chevron, GitHub, close,
      check, menu), stroke 2, square caps.
- [x] Structural devices encode truth: "///" marks topics, numbers only on the real stage sequence.
- [x] One mascot, one pose per screen, tied to the state it represents.
- [x] Dark theme designed (serif weight change, white rules, candy blocks kept), not inverted.
- [x] No cream background, no acid-green-on-black, no hairline broadsheet.

---

## 12. Implementation notes

- CSP: no `url()` with `data:` anywhere in CSS (masks, chevrons and checks are gradients or borders).
  All icons are inline SVG in components.
- Theme switch: `data-theme` on `<html>`; default follows `prefers-color-scheme`. Duplicate the dark block
  under the media query as noted in §2.
- Keep every ARIA role, label and visible control text; the only visible text changes are on Home
  (§9) and new optional strings (empty states, footer) added to i18n.
- File split: tokens + shared classes in `globals.css` (target under 800 lines; move form styles to a
  `forms` section), shell + footer in `shell.css`, everything in §9 in `home.css`, route classes
  (`.connector`, `.checks`, `.stage-*`) in `globals.css` because the route page reuses them.
