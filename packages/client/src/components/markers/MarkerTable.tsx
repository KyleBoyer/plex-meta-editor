import { useState } from 'react';
import type { Marker } from '@plex-meta-editor/shared';
import { useMarkerStore } from '../../stores/markers';
import { formatTime } from '../../utils/time';

interface Props {
  markers: Marker[];
  onEdit?: (marker: Marker) => void;
  onJump?: (ms: number) => void;
  onDeleted?: () => void;
}

const TYPE_STYLES: Record<string, { dotVar: string; bg: string; text: string }> = {
  intro: { dotVar: 'var(--color-marker-intro)', bg: 'marker-intro-bg', text: 'marker-intro-text' },
  credits: { dotVar: 'var(--color-marker-credits)', bg: 'marker-credits-bg', text: 'marker-credits-text' },
  commercial: { dotVar: 'var(--color-marker-commercial)', bg: 'marker-commercial-bg', text: 'marker-commercial-text' },
};

export function MarkerTable({ markers, onEdit, onJump, onDeleted }: Props) {
  const { deleteMarker, saving } = useMarkerStore();
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this marker? This writes immediately to the database (with backup).')) return;
    setDeletingId(id);
    try {
      await deleteMarker(id);
      onDeleted?.();
    } catch { /* store has error */ }
    setDeletingId(null);
  };

  if (markers.length === 0) {
    return (
      <div className="plex-stage-panel text-center py-10 px-6">
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-white/8 border border-white/8 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </div>
        <p className="text-sm text-white font-semibold">No markers yet</p>
        <p className="text-[13px] text-[var(--color-text-muted)] mt-1">Use the player to set precise timestamps and create the first marker.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="plex-kicker">{markers.length} marker{markers.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="space-y-1.5 md:space-y-1">
        {markers.map(marker => {
          const style = TYPE_STYLES[marker.type] || { dotVar: '#888', bg: '', text: 'text-zinc-400' };
          return (
            <div
              key={marker.id}
              className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 px-4 py-3 rounded-[20px] border border-white/8 bg-white/5 hover:bg-white/7 hover:border-white/14 transition-colors group backdrop-blur-sm"
            >
              {/* Top row on mobile: type + timecodes */}
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
                {/* Type indicator */}
                <div className="flex items-center gap-2 min-w-[80px]">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: style.dotVar }} />
                  <span className={`text-[11px] font-medium uppercase tracking-wide ${style.text}`}>{marker.type}</span>
                </div>

                {/* Timecodes */}
                <div className="flex items-center gap-1">
                  <span className="timecode text-[11px] text-zinc-300">{formatTime(marker.start)}</span>
                  <span className="text-zinc-500 text-[11px]">&rarr;</span>
                  <span className="timecode text-[11px] text-zinc-300">{formatTime(marker.end)}</span>
                  <span className="text-zinc-500 text-[11px] ml-1">({formatTime(marker.end - marker.start)})</span>
                </div>

                {/* Final badge */}
                {marker.isFinal && (
                  <span className="text-[10px] uppercase tracking-wider text-amber-300 font-medium border border-amber-400/20 rounded-full px-2 py-0.5">final</span>
                )}
              </div>

              {/* Spacer (desktop) */}
              <div className="hidden sm:block flex-1" />

              {/* Actions — always visible on mobile, hover on desktop */}
              <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onJump?.(marker.start)}
                  className="ctrl-btn text-[11px] px-2 py-1 sm:py-0.5"
                  title="Jump to marker start"
                >
                  &#9654; Jump
                </button>
                <button
                  onClick={() => onEdit?.(marker)}
                  className="ctrl-btn text-[11px] px-2 py-1 sm:py-0.5"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(marker.id)}
                  disabled={saving}
                  className="ctrl-btn text-[11px] px-2 py-1 sm:py-0.5 text-red-400/80 hover:text-red-400 hover:border-red-500/30 disabled:opacity-40"
                >
                  {deletingId === marker.id ? '\u2026' : '\u00d7'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
