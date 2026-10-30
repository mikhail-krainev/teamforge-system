# Teamforge redesign: shared brief

Single source of context for every design and implementation agent. Read this file first; do not
re-derive what it states.

## Product

Teamforge is a free web platform for students and junior specialists from Russia and the CIS. People
fill a profile, form or join a team (queue with role priorities, auto-matching, trial period), and go
through a full product cycle (idea, development, release) on a ready route of stages with
checklists. GitHub integration feeds a contribution log. Participants who meet the conditions get
cosmetic awards. No ratings, levels or comparisons between people. Interface language: Russian.
Tone: friendly, a bit playful, honest; a peer, not a corporation.

## Reference

https://waxyweb.com (design agency site). Take its spirit, not its layout one to one:

- White page, pure black text. Thick black 2px rules, the content "sheet" has rounded top corners.
- Bold grotesk display type (Helvetica Neue 500, tight negative tracking) mixed inside one headline
  with a thin high-contrast serif word (Editorial New Light).
- Candy flat fills used as big blocks, never as gradients: pink #FFADE4, yellow #FFF570,
  blue #0088CC, green #25A750, brown #AB6349, orange #FFA970, red #E95935, light grey #F0F0F0.
- Pills everywhere (radius 200px), cards with 32-40px radius, round icon buttons beside pill
  buttons ("Free Consultation" + round arrow).
- Playful details: wavy/scalloped testimonial cards slightly rotated, stickers, marquee strips of
  client names, a doodle character in the footer, "///" section marks, oval outline around a
  heading ("Since 2022").
- Generous whitespace, huge headings, small grey body copy aligned to a right column.

Excluded by the owner: the number-wheel preloader.

## Owner feedback on the first attempt

"Looks cheap and bad." The first pass only swapped tokens on the old layout: same boxes, generic
Inter Tight, pastel tiles, no hierarchy, no identity. The redesign must be a real UI/UX designer's
work: layout system, type scale, rhythm, states, empty states, identity.

## Must not look AI-made

Avoid these tells: Inter/Manrope/Poppins, purple-blue gradients, glassmorphism, centred hero with
two buttons, three equal feature cards with icons, emoji in UI, everything the same radius, uniform
grey shadows, perfectly symmetric grids, generic copy ("Unlock your potential"), Lucide icon soup.
Prefer: an opinionated type pairing, asymmetric editorial grid, deliberate scale contrast, hand-made
details (custom SVG marks, stickers, scallops, rotated labels), real microcopy in Russian, a few
strong colour blocks instead of many pastel ones, consistent mascot-driven moments.

## Identity: mascot

Mascot is a Yeti. Style: pixel-art like Clawd (the blocky orange pixel crab of Claude Code): a
small, chunky sprite drawn on a coarse grid (about 16x16 to 24x24 cells), flat fills, 2-3 colours,
no outlines or anti-aliasing, crisp `shape-rendering="crispEdges"`, cute and slightly goofy. It is
an original character, not a copy of Clawd. Needed poses: idle, waving (hello / home), thinking
(loading), sad (error / 404), celebrating (award / project completed), sleeping or looking around
(empty state). Plus a wordmark lockup for the header.

## Hard technical constraints

- Next.js 16 app router in `apps/web`. Styling is plain global CSS with semantic classes; no
  Tailwind, no CSS-in-JS, no new UI library. Files: `src/app/globals.css` (tokens + shared
  components), `src/components/shell/shell.css`, `src/app/home.css`. Feature components use these
  shared classes: `button` (+`button-secondary`, `button-danger`, `button-block`), `card`
  (+`nested`), `stack`, `row`, `muted`, `lead`, `page-narrow`, `page-wide`, `grid-2`, `tag`,
  `tag-list`, `alert` (+`alert-error|warn|success|info`), `field`, `field-label`, `field-hint`,
  `field-error`, `checkbox`, `data-table`, `table-scroll`, `definition-list`, `plain-list`,
  `award-list`/`award`, `modal`/`modal-backdrop`, `bell-*`, `spinner`, `divider`, `pre-text`,
  `consent-text`, `pref-*`, `check-grid`, `icon-button`, `sr-only`. Changing a class name means
  changing every feature file that uses it; prefer restyling classes and adding new ones.
- Content-Security-Policy: fonts, images and scripts from `'self'` only. Fonts through
  `next/font/google` (self-hosted at build). Inline `<svg>` is fine. No external images or CDNs.
- Every font must cover Cyrillic.
- Accessibility: WCAG AA contrast for all text pairs in both themes, visible focus, tap targets
  44px, `prefers-reduced-motion` honoured, existing ARIA and roles kept (tests query them).
- Light and dark themes (owner decision). Dark is not an inverted copy: black page, same candy
  blocks with black text.
- Keep existing i18n flow: strings in `src/i18n/ru/*.json`, read with `t('file.key')`.
- Unit tests (`vitest`) query by role and Russian text; do not change visible text of existing
  controls unless the spec says so.

## Screens

Shell (header, nav of 8 items: Главная, Профиль, Команды, Мои предложения, Поиск команды, Спрос на
роли, Отзывы, Аккаунт; notification bell; sign-in / sign-out), Home, Sign-in (GitHub + magic link),
Profile (long form: stack picker, role preferences, experience, resume upload), Teams list +
filters, Team detail (seats, actions, events), Create team, Search / Demand (matching), Offers,
Route of stages and stage checklist, Feed (GitHub contribution log), Votes, Completion and credit
(awards), Reviews, Admin fraud queue, 404.

## Working rules for agents

- Write results to files; reply to the orchestrator with at most 150 words: what you produced,
  file paths, open questions. No pasted file contents.
- Read only the files you need. Do not re-read this brief's sources.
- Do not commit. Do not touch files outside your assignment.
