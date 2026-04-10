import { useMemo } from 'react';
import type { Marker } from '@plex-meta-editor/shared';

interface Props {
  currentTime: number;
  markers: Marker[];
  onSkip?: (marker: Marker) => void;
}

const TYPE_META: Record<string, { label: string; className: string }> = {
  intro: { label: 'Intro', className: 'bg-green-500/20 text-green-400 border-green-500/30' },
  credits: { label: 'Credits', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  commercial: { label: 'Commercial', className: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
};

export function MarkerOverlay({ currentTime, markers, onSkip }: Props) {
  const activeMarker = useMemo(() => {
    return markers.find(m => currentTime >= m.start && currentTime < m.end);
  }, [currentTime, markers]);

  if (!activeMarker) return null;

  const meta = TYPE_META[activeMarker.type] || { label: activeMarker.type, className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30' };

  return (
    <>
      <div className="pointer-events-none absolute bottom-14 left-3 z-20 animate-fade-in">
        <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-medium backdrop-blur-sm ${meta.className}`}>
          <span className="uppercase tracking-wider">{meta.label}</span>
          <span className="opacity-50">·</span>
          <span className="timecode opacity-75">{fmt(activeMarker.start)}–{fmt(activeMarker.end)}</span>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-14 right-3 z-20 animate-fade-in">
        <button
          type="button"
          onClick={() => onSkip?.(activeMarker)}
          className={`pointer-events-auto inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-medium backdrop-blur-sm transition-[filter,transform] hover:brightness-110 active:scale-[0.98] cursor-pointer ${meta.className}`}
        >
          <span className="uppercase tracking-wider">Skip {meta.label}</span>
        </button>
      </div>
    </>
  );
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
