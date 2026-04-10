import { useState } from 'react';
import type { Chapter } from '@plex-meta-editor/shared';
import { useChapterStore } from '../../stores/chapters';
import { formatTimeFull, parseTime } from '../../utils/time';

interface Props {
  /** If editing, the index of the chapter being edited */
  editIndex?: number | null;
  /** All current chapters (needed because we save the entire list) */
  allChapters: Chapter[];
  metadataId: number;
  onGetCurrentTime?: () => number;
  onClose: () => void;
  onSaved: () => void;
}

export function ChapterForm({ editIndex, allChapters, metadataId, onGetCurrentTime, onClose, onSaved }: Props) {
  const { setChapters, saving, error } = useChapterStore();
  const isEdit = editIndex != null && editIndex >= 0;
  const existing = isEdit ? allChapters[editIndex!] : undefined;

  const [name, setName] = useState(existing?.name || '');
  const [startTime, setStartTime] = useState(
    existing ? formatTimeFull(existing.start) : '0:00:00.000'
  );
  const [endTime, setEndTime] = useState(
    existing ? formatTimeFull(existing.end) : '0:00:00.000'
  );
  const [formError, setFormError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const startMs = parseTime(startTime);
    const endMs = parseTime(endTime);

    if (startMs === null || endMs === null) {
      setFormError('Invalid time format. Use H:MM:SS.mmm');
      return;
    }
    if (startMs >= endMs) {
      setFormError('Start time must be before end time');
      return;
    }

    const newChapter: Chapter = { name, start: startMs, end: endMs };

    try {
      let updated: Chapter[];
      if (isEdit) {
        // Replace the chapter at editIndex
        updated = allChapters.map((ch, i) => i === editIndex ? newChapter : ch);
      } else {
        // Insert and sort by start time
        updated = [...allChapters, newChapter].sort((a, b) => a.start - b.start);
      }

      await setChapters(metadataId, updated);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-md"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-lg sm:rounded-lg border border-white/8 bg-[#1c1c1c] shadow-[0_28px_60px_rgba(0,0,0,0.44)] animate-slide-up sm:animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-white/8 sticky top-0 bg-[#1c1c1c] z-10">
          {/* Drag indicator for mobile */}
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-zinc-600 sm:hidden" />
          <h3 className="text-base font-semibold text-white">{isEdit ? 'Edit Chapter' : 'Add Chapter'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none p-1">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="px-4 sm:px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Chapter name (optional)"
              className="plex-input w-full rounded-[18px] placeholder:text-zinc-500"
            />
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

          {/* End Time */}
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

          {/* Plex scan warning */}
          <div className="text-amber-400/80 text-[11px] bg-amber-500/8 border border-amber-500/20 rounded px-3 py-2">
            Note: A Plex library scan may revert chapter edits by re-reading from the media file.
          </div>

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
              {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Chapter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
