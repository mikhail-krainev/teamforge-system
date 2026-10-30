# Толик lives on the home page

Spec for this pass. Read it with `docs/design/motion-brief.md` (tokens, motion rules, CSP).
All new code lives in `apps/web/src/components/mascot/life/` unless stated.

## Behaviour (owner request, 2026-10-30)

- Толик starts in his hero slot (the existing `LiveYeti` with the greeting bubble). When the reader
  scrolls, he leaves the slot and travels over the page blocks themselves: he stands on the top
  edges of cards, walks along them and jumps, drops or climbs between them so he stays near the
  reader. Scrolling back to the top brings him back into the slot, where he stands as before.
- Travel must look good: anticipation crouch, arc with an airborne pose, landing squash, walk cycle
  with a bob, parachute for long drops, balloon for long climbs.
- He lives his own life while the reader is idle: walks about, wipes the screen with a rag, reads a
  book, lights a campfire and sits by it, plays the guitar, sometimes asks the reader a question
  (the reader can type an answer; he replies with a canned line), very rarely scrolls the page a
  little as if studying it, falls asleep after a long idle.
- Sometimes (desktop, fine pointer only) he jumps up, grabs the cursor and dangles from it with a
  pendulum swing while the reader moves it; he lets go after a few seconds and falls back.
- `prefers-reduced-motion: reduce`: none of this; he stays in the hero slot as now.

## Module ownership

- Sprite agent: `life/sprites.ts`, palette additions in `pixels.tsx` and `mascot.css`.
- Chat agent: `life/YetiChat.tsx`, `life/chat.ts`, `life/chat.test.ts`, chat keys in
  `i18n/ru/mascot.json` (under `"chat"`).
- Lead: everything else in `life/`, `app/page.tsx`, removal of `ScrollBuddy`.

## Interface: sprites (`life/sprites.ts`)

All body frames are 20x20 grids in the same style and palette chars as `components/mascot/Yeti.tsx`
(`F` fur, `S` fur shade, `B` face, `K` ink, `E` eye, `C` cheek, `.` empty), facing RIGHT (the
engine mirrors with scaleX(-1)). Feet touch the bottom row; the body keeps the same width and
head position across frames so swaps do not jump.

```ts
export type BodyFrame =
  | 'stand' | 'blink' | 'walk1' | 'walk2' | 'crouch' | 'jump' | 'fall' | 'land'
  | 'hang1' | 'hang2' | 'sit' | 'sitRead1' | 'sitRead2' | 'sitGuitar1' | 'sitGuitar2'
  | 'wipe1' | 'wipe2' | 'talk' | 'happy' | 'sleep' | 'peek';
export const BODY: Record<BodyFrame, readonly string[]>;

export type PropName =
  | 'book' | 'guitar' | 'fire1' | 'fire2' | 'fire3' | 'logs' | 'rag' | 'sparkle'
  | 'parachute' | 'balloon' | 'note' | 'magnifier' | 'zzz';
/** grid: any size up to 24x24; offset: top-left of the prop in BODY cells, relative to the body's
 *  top-left (may be negative, e.g. the parachute sits above the head). */
export const PROPS: Record<PropName, { grid: readonly string[]; offset: readonly [number, number] }>;
```

`hang1/hang2`: both arms straight up, hands at the top row (he holds the cursor there), legs swing.
`sit*`: sitting on the ledge, feet still at the bottom row. `wipe1/2`: facing the reader, one arm
moving a rag in a circle (rag is a prop, arm position differs). `peek`: leaning forward, looking
down at the page (used with `magnifier`).

Prop palette chars (added to `PALETTE` in `pixels.tsx`, classes in `mascot.css`, token fills only):
`R` var(--red), `O` var(--orange), `Y` var(--yellow), `W` var(--brown) (wood, guitar body),
`P` var(--pink), `U` var(--ultramarine), `G` var(--green), `M` var(--mint), `L` var(--white)
(paper, book pages), `N` var(--ink) (strings, outlines).

## Interface: chat (`life/YetiChat.tsx`)

```ts
export function YetiChat(props: {
  questionKey: ChatQuestionKey;       // which question he asks
  onDone: (mood: ChatMood) => void;   // after his reply has been shown (or on dismiss: 'neutral')
}): JSX.Element;
export type ChatMood = 'happy' | 'neutral' | 'surprised' | 'shy';
export const CHAT_QUESTIONS: readonly ChatQuestionKey[];
```

A small speech-bubble form rendered by the engine next to Толик: the question, a text input
(label = the question, maxLength 80), a send button, a close button. Submit shows his canned reply
picked by keyword matching in `chat.ts` (pure function, unit tested), then `onDone` after ~2.5s.
Escape closes. It never steals focus on appear. Russian, peer tone, no emoji.
