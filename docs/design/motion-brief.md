# Корнер: motion, mascot and palette pass

Shared context for agents of this pass. Read it together with `docs/design/brief.md` (product,
constraints, anti-AI rules). Do not re-read files this brief already summarizes.

## Decisions (owner, 2026-10-30)

- Service is renamed from Teamforge to **Корнер** (wordmark may render uppercase "КОРНЕР").
- Palette direction: risograph print. Flat ink fills on warm paper, never gradients.
- Light/dark theme gets a manual toggle in the header (system is the default).
- More motion across pages, most of it on the home page (it will grow into the landing page).
- The Yeti mascot reacts to cursor proximity and clicks with several different animations.

## Tokens (in `apps/web/src/app/globals.css`, names kept, values changed)

Fills, same in both themes, always with dark ink text (`--on-candy`, all pass AA):
`--yellow` sunflower, `--pink` fluo pink, `--red` vermilion, `--orange` apricot, `--blue`
cornflower, `--green` riso teal, `--mint`, `--grey` paper shade. Deep accent `--ultramarine`
(#3A47D5) is for decoration and large display marks only, never for body text on fills.
Semantic tokens: `--bg`, `--surface`, `--surface-2`, `--ink`, `--muted`, `--rule`, `--focus`.
Motion tokens: `--dur-fast`, `--dur`, `--dur-slow`, `--ease-out`, `--ease-spring`.
Theme: `html[data-theme='light'|'dark']` forces a theme; without it the system theme applies.
Never hardcode hex colours in feature CSS; use tokens.

## Ownership (files each agent may edit; nothing else)

- Lead (main session): `globals.css`, `layout.tsx`, `components/shell/*`, i18n `shell.json`,
  `auth.json`, rename, theme toggle.
- Mascot agent: `components/mascot/*` (new files allowed), i18n `ru/mascot.json` (new).
- Motion agent: `app/page.tsx`, `app/home.css`, new `app/motion.css`, i18n `ru/home.json`.
  `motion.css` is imported in `layout.tsx` by the lead.

## Motion rules

- CSS first. JS only where CSS cannot do it (pointer tracking, click reactions).
- Scroll reveals: CSS scroll-driven animations (`animation-timeline: view()`) inside
  `@supports (animation-timeline: view())`; content is fully visible without support.
- Everything inside `@media (prefers-reduced-motion: no-preference)`, or disabled under `reduce`.
- Animate only `transform` and `opacity` (and `clip-path` for reveals). No layout thrash.
- Feel: printed paper, stickers, stamps, slight overshoot (`--ease-spring`). No glow, no blur,
  no parallax soup, no gradient shimmer.
- CSP: no inline `<script>`, no external assets. Inline SVG and `style` props are fine.
- Keep existing roles, labels and visible text; unit tests query them.
