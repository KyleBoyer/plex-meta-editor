import type { Marker } from '@plex-meta-editor/shared';

interface Props {
  markers: Marker[];
  duration: number; // milliseconds
  onMarkerClick?: (marker: Marker) => void;
}

const TYPE_COLORS: Record<string, string> = {
  intro: 'bg-green-500/80 hover:bg-green-500',
  credits: 'bg-blue-500/80 hover:bg-blue-500',
  commercial: 'bg-orange-500/80 hover:bg-orange-500',
};

export function MarkerTimeline({ markers, duration, onMarkerClick }: Props) {
  if (!duration || duration <= 0) {
    return <div className="h-10 bg-gray-800 rounded text-center text-xs text-gray-500 leading-10">No duration data</div>;
  }

  return (
    <div className="relative h-10 bg-gray-800 rounded overflow-hidden group">
      {/* Time labels */}
      <div className="absolute inset-0 flex items-end justify-between px-2 pb-0.5 text-[11px] text-gray-500 pointer-events-none">
        <span>0:00</span>
        <span>{formatTime(duration / 2)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      {/* Marker blocks */}
      {markers.map(marker => {
        const left = Math.min((marker.start / duration) * 100, 100);
        const endPct = Math.min((marker.end / duration) * 100, 100);
        const width = Math.max(endPct - left, 0);
        const color = TYPE_COLORS[marker.type] || 'bg-purple-500/80';

        return (
          <button
            key={marker.id}
            onClick={() => onMarkerClick?.(marker)}
            className={`absolute top-0 h-full ${color} transition-colors cursor-pointer border-r border-l border-white/10`}
            style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
            title={`${marker.type}: ${formatTime(marker.start)} - ${formatTime(marker.end)}`}
          >
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white/90 truncate px-0.5">
              {width > 8 ? marker.type : ''}
            </span>
          </button>
        );
      })}

      {/* Empty state */}
      {markers.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500">
          No markers
        </div>
      )}
    </div>
  );
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
