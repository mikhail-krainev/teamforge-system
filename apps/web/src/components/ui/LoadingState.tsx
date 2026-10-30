import { Yeti } from '@/components/mascot/Yeti';
import './ui.css';

/** Left-aligned loading moment: thinking Yeti, spinner and a status line (spec §8, global states). */
export function LoadingState({ text, spinner = false }: { text: string; spinner?: boolean }) {
  return (
    <div className="page-loading">
      <Yeti pose="think" size={96} />
      <p role="status" className="mono">
        {spinner ? <span className="spinner" aria-hidden="true" /> : null}
        {text}
      </p>
    </div>
  );
}
