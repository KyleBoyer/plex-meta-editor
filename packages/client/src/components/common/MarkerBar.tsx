import { useLibraryStore } from '../../stores/library';
import { useSettingsStore } from '../../stores/settings';

interface MarkerBarProps {
  /** Movie or episode ID to look up markers in the summary store */
  itemId: number;
  /** Total duration in ms — use fileDuration when available */
  duration: number;
  /** CSS class for positioning: 'plex-marker-line' (grid) or 'plex-marker-bg' (detail/table) */
  className: string;
  /** Opacity for each segment (default 1 for line, use ~0.15 for bg) */
  segmentOpacity?: number;
  /** Episode boundary positions in ms (for multi-episode files) */
  episodeBoundaries?: number[];
}

export function MarkerBar({ itemId, duration, className, segmentOpacity = 1, episodeBoundaries }: MarkerBarProps) {
  const markers = useLibraryStore(s => s.markerSummary[itemId]);
  const chapters = useLibraryStore(s => s.chapterSummary[itemId]);
  const visibility = useSettingsStore(s => s.overlayVisibility);
  const colors = useSettingsStore(s => s.overlayColors);

  const visibleMarkers = markers?.filter(m => {
    if (m.type === 'intro' && !visibility.intro) return false;
    if (m.type === 'commercial' && !visibility.commercial) return false;
    if (m.type === 'credits' && !visibility.credits) return false;
    return true;
  });

  const hasChapters = visibility.chapterBoundary && chapters && chapters.length > 0;
  const hasBoundaries = visibility.episodeBoundary && episodeBoundaries && episodeBoundaries.length > 0;

  // Always render the bar container — even when empty — to show the track
  if (duration <= 0) return null;

  return (
    <div className={className}>
      {visibleMarkers?.map((marker, i) => {
        const clampedEnd = Math.min(marker.end, duration);
        const left = (marker.start / duration) * 100;
        const width = ((clampedEnd - marker.start) / duration) * 100;
        if (width <= 0) return null;

        return (
          <div
            key={i}
            className="plex-marker-segment"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: colors[marker.type as keyof typeof colors] || 'rgba(161, 161, 170, 0.4)',
              opacity: segmentOpacity,
            }}
          />
        );
      })}
      {hasChapters && chapters!.map((pos, i) => {
        const pct = (pos / duration) * 100;
        return (
          <div
            key={`ch-${i}`}
            className="plex-marker-chapter"
            style={{ left: `${pct}%`, borderLeftColor: colors.chapterBoundary }}
          />
        );
      })}
      {hasBoundaries && episodeBoundaries!.map((pos, i) => {
        const pct = (pos / duration) * 100;
        return (
          <div
            key={`b-${i}`}
            className="plex-marker-boundary"
            style={{ left: `${pct}%`, background: colors.episodeBoundary }}
          />
        );
      })}
    </div>
  );
}
