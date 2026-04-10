import { useState } from 'react';
import type { Marker } from '@plex-meta-editor/shared';
import { MarkerType } from '@plex-meta-editor/shared';
import { useMarkerStore } from '../../stores/markers';
import { formatTimeFull, parseTime } from '../../utils/time';

interface Props {
  marker?: Marker | null;
  parentId: number;
  initialStart?: number | null;
  initialEnd?: number | null;
  initialType?: string | null;
  duration?: number;
  onGetCurrentTime?: () => number;
  onClose: () => void;
  onSaved: () => void;
}

export function MarkerForm({ marker, parentId, initialStart, initialEnd, initialType, duration, onGetCurrentTime, onClose, onSaved }: Props) {
  const { addMarker, editMarker, saving, error } = useMarkerStore();
  const isEdit = !!marker;

  const [type, setType] = useState<string>(marker?.type || initialType || 'intro');
  const [startTime, setStartTime] = useState(
    initialStart != null ? formatTimeFull(initialStart) : marker ? formatTimeFull(marker.start) : '0:00:00.000'
  );
  const [endTime, setEndTime] = useState(
    initialEnd != null ? formatTimeFull(initialEnd) : marker ? formatTimeFull(marker.end) : '0:00:00.000'
  );
  const [isFinal, setIsFinal] = useState(marker?.isFinal || false);
  const [savedEndTime, setSavedEndTime] = useState('');
  const [formError, setFormError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const startMs = parseTime(startTime);
    const endMs = parseTime(endTime);
    if (startMs === null || endMs === null) { setFormError('Invalid time format. Use H:MM:SS.mmm'); return; }
    if (startMs >= endMs) { setFormError('Start time must be before end time'); return; }
    try {
      if (isEdit && marker) {
        await editMarker(marker.id, { type: type as MarkerType, start: startMs, end: endMs, isFinal });
      } else {
        await addMarker({ parentId, type: type as MarkerType, start: startMs, end: endMs, isFinal });
      }
      onSaved();
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const grabCurrentTime = (setter: (v: string) => void) => {
    if (onGetCurrentTime) {
      const ms = onGetCurrentTime();
      setter(formatTimeFull(ms));
    }
  };

  const handleFinalToggle = (checked: boolean) => {
    setIsFinal(checked);
    if (checked && duration) {
      setSavedEndTime(endTime);
      setEndTime(formatTimeFull(duration));
    } else if (!checked && savedEndTime) {
      setEndTime(savedEndTime);
      setSavedEndTime('');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-md"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-lg sm:rounded-lg border border-white/8 bg-[#1c1c1c] shadow-[0_28px_60px_rgba(0,0,0,0.44)] animate-slide-up sm:animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-white/8 sticky top-0 bg-[#1c1c1c] z-10">
          {/* Drag indicator for mobile */}
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-zinc-600 sm:hidden" />
          <h3 className="text-base font-semibold text-white">{isEdit ? 'Edit Marker' : 'Add Marker'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none p-1 cursor-pointer">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="px-4 sm:px-5 py-4 space-y-4">
          {/* Type */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-1.5">Type</label>
            <div className="flex gap-1.5">
              {(['intro', 'credits', 'commercial'] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setType(t); if (t !== 'credits') { setIsFinal(false); if (savedEndTime) { setEndTime(savedEndTime); setSavedEndTime(''); } } }}
                  className={`flex-1 px-3 py-2.5 sm:py-2 rounded text-[11px] font-medium border transition-all capitalize cursor-pointer ${
                    type === t
                      ? t === 'intro' ? 'bg-green-500/10 border-green-500/30 text-green-400'
                        : t === 'credits' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                        : 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                      : 'bg-[var(--color-surface-2)] border-[var(--color-border)] text-zinc-400 hover:border-[var(--color-border-bright)]'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Start Time */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-1.5">Start Time</label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                placeholder="0:00:00.000"
                className="plex-input flex-1 timecode"
              />
              {onGetCurrentTime && (
                <button
                  type="button"
                  onClick={() => grabCurrentTime(setStartTime)}
                  className="ctrl-btn ctrl-btn-accent text-[11px] px-2.5 sm:px-2 whitespace-nowrap"
                  title="Use current video time"
                >
                  &#9201; Current
                </button>
              )}
            </div>
          </div>

          {/* Final */}
          {type === 'credits' && (
            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer py-1">
              <input
                type="checkbox"
                checked={isFinal}
                onChange={e => handleFinalToggle(e.target.checked)}
                className="rounded border-zinc-600 bg-[var(--color-surface-2)] w-4 h-4"
              />
              Mark as final credits (extends to end)
            </label>
          )}

          {/* End Time */}
          {!(type === 'credits' && isFinal) && (
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-1.5">End Time</label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                placeholder="0:00:30.000"
                className="plex-input flex-1 timecode"
              />
              {onGetCurrentTime && (
                <button
                  type="button"
                  onClick={() => grabCurrentTime(setEndTime)}
                  className="ctrl-btn ctrl-btn-accent text-[11px] px-2.5 sm:px-2 whitespace-nowrap"
                  title="Use current video time"
                >
                  &#9201; Current
                </button>
              )}
            </div>
          </div>
          )}

          {/* Errors */}
          {(formError || error) && (
            <div className="text-red-400 text-xs bg-red-500/8 border border-red-500/20 rounded px-3 py-2">
              {formError || error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1 pb-safe">
            <button type="button" onClick={onClose} className="ctrl-btn text-xs px-4 py-2 sm:py-1.5">Cancel</button>
            <button type="submit" disabled={saving} className="ctrl-btn ctrl-btn-accent text-xs px-5 py-2 sm:py-1.5 disabled:opacity-40">
              {saving ? 'Saving\u2026' : isEdit ? 'Save Changes' : 'Add Marker'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
