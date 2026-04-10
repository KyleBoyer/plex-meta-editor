import { useRef, useState, useCallback } from 'react';
import type { Marker, Chapter } from '@plex-meta-editor/shared';
import { formatTime } from '../../utils/time';
import { useSettingsStore } from '../../stores/settings';

export interface EpisodeBoundary {
  /** Position in ms on the unified timeline where this boundary sits */
  position: number;
  /** Label like "E01 | E02" */
  label: string;
}

interface Props {
  currentTime: number;
  duration: number;
  markers: Marker[];
  chapters?: Chapter[];
  onSeek: (ms: number) => void;
  /** Episode boundaries for multi-episode files */
  episodeBoundaries?: EpisodeBoundary[];
  /** Called when a boundary is dragged to a new position */
  onBoundaryDrag?: (index: number, newPosition: number) => void;
}


export function PlayerTimeline({ currentTime, duration, markers, chapters, onSeek, episodeBoundaries, onBoundaryDrag }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [draggingBoundary, setDraggingBoundary] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState(0);
  const overlayColors = useSettingsStore(s => s.overlayColors);

  const progress = duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;

  const getTimeFromX = useCallback((clientX: number) => {
    if (!trackRef.current || duration <= 0) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const time = getTimeFromX(e.clientX);
    onSeek(time);
  }, [getTimeFromX, onSeek]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const time = getTimeFromX(e.clientX);
    if (trackRef.current) {
      const rect = trackRef.current.getBoundingClientRect();
      setHoverPos(((e.clientX - rect.left) / rect.width) * 100);
    }
    setHoverTime(time);
    if (draggingBoundary !== null) {
      onBoundaryDrag?.(draggingBoundary, time);
    } else if (dragging) {
      onSeek(time);
    }
  }, [dragging, draggingBoundary, getTimeFromX, onSeek, onBoundaryDrag]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
    setDraggingBoundary(null);
  }, []);

  const handleBoundaryPointerDown = useCallback((e: React.PointerEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingBoundary(index);
    // Capture on the track element so moves work across the full width
    trackRef.current?.setPointerCapture(e.pointerId);
  }, []);

  return (
    <div className="px-0 py-1">
      <div
        ref={trackRef}
        className="scrubber-track relative h-6 group cursor-pointer"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => { setHoverPos(null); setDragging(false); setDraggingBoundary(null); }}
      >
        {/* Track background */}
        <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 bg-[var(--color-surface-3)] rounded-full overflow-hidden">
          {/* Progress fill */}
          <div
            className="absolute inset-y-0 left-0 bg-zinc-500/40 transition-[width] duration-75"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Marker regions */}
        {markers.map(marker => {
          const left = duration > 0 ? Math.min((marker.start / duration) * 100, 100) : 0;
          const endPct = duration > 0 ? Math.min((marker.end / duration) * 100, 100) : 0;
          const width = Math.max(endPct - left, 0);
          const color = overlayColors[marker.type as keyof typeof overlayColors] || '#888';

          return (
            <div
              key={marker.id}
              className="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-sm opacity-35 group-hover:opacity-50 transition-opacity pointer-events-none"
              style={{
                left: `${left}%`,
                width: `${Math.max(width, 0.3)}%`, // min 0.3% so tiny markers remain visible
                background: color,
              }}
              title={`${marker.type}: ${formatTime(marker.start)} – ${formatTime(marker.end)}`}
            />
          );
        })}

        {/* Chapter boundaries */}
        {chapters && chapters.length > 0 && chapters.map((chapter, i) => {
          if (i === 0) return null; // skip first chapter start (always 0)
          const pct = duration > 0 ? (chapter.start / duration) * 100 : 0;
          return (
            <div
              key={`chapter-${i}`}
              className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-[rgba(168,130,255,0.35)] pointer-events-none"
              style={{ left: `${pct}%` }}
              title={chapter.name ? `Ch. ${i + 1}: ${chapter.name}` : `Chapter ${i + 1}`}
            />
          );
        })}

        {/* Episode boundaries */}
        {episodeBoundaries?.map((boundary, i) => {
          const pct = duration > 0 ? (boundary.position / duration) * 100 : 0;
          return (
            <div
              key={`boundary-${i}`}
              className="absolute top-0 bottom-0 z-10"
              style={{ left: `${pct}%` }}
            >
              {/* Label — centered on the boundary position */}
              <div
                className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-[9px] text-zinc-500 font-medium whitespace-nowrap pointer-events-none select-none"
              >
                {boundary.label}
              </div>
              {/* Wide drag handle — centered on the line */}
              <div
                className={`absolute top-2 bottom-0 cursor-col-resize -translate-x-1/2 ${
                  draggingBoundary === i ? 'w-4' : 'w-3 hover:w-4'
                }`}
                title={boundary.label}
                onPointerDown={e => handleBoundaryPointerDown(e, i)}
              >
                {/* Visible dashed line */}
                <div
                  className={`mx-auto w-px h-full pointer-events-none ${
                    draggingBoundary === i ? 'border-l border-dashed border-zinc-300' : 'border-l border-dashed border-zinc-500/60'
                  }`}
                />
              </div>
            </div>
          );
        })}

        {/* Hover indicator */}
        {hoverPos !== null && draggingBoundary === null && (
          <>
            <div
              className="absolute top-1/2 -translate-y-1/2 w-px h-4 bg-zinc-400/30 pointer-events-none"
              style={{ left: `${hoverPos}%` }}
            />
            <div
              className="absolute -top-6 -translate-x-1/2 px-1.5 py-0.5 bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded text-[10px] timecode text-zinc-300 pointer-events-none whitespace-nowrap"
              style={{ left: `${hoverPos}%` }}
            >
              {formatTime(hoverTime)}
            </div>
          </>
        )}

        {/* Playhead */}
        <div className="scrubber-playhead" style={{ left: `${progress}%` }} />
      </div>
    </div>
  );
}

