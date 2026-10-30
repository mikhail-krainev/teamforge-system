import { PixelSprite } from './pixels';

// 12x12 cells, same palette chars as the full Yeti.
const MARK: readonly string[] = [
  '.....SF.....',
  '....SFF.....',
  '..SFFFFFFF..',
  '.SFBBBBBBFF.',
  '.SBBBBBBBBF.',
  '.SBKKBBKKBF.',
  '.SBKKBBKKBF.',
  '.SBBBBBBBBF.',
  '.SBBKKFKBBF.',
  '.SFBBBBBBFS.',
  '..SFFFFFFF..',
  '..SSSSSSSS..',
];

/** Head-only Yeti for the header logo. Decorative by default; pass `title` when it stands alone. */
export function YetiMark({ size = 32, title }: { size?: number; title?: string }) {
  return <PixelSprite grid={MARK} size={size} title={title} className="yeti-mark" />;
}
