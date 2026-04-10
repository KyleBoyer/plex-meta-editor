import { useState } from 'react';
import type { Chapter } from '@plex-meta-editor/shared';
import { useChapterStore } from '../../stores/chapters';
import { formatTime } from '../../utils/time';

interface Props {
  chapters: Chapter[];
  metadataId: number;
  onEdit: (index: number) => void;
  onJump?: (ms: number) => void;
  onSaved?: () => void;
}

export function ChapterTable({ chapters, metadataId, onEdit, onJump, onSaved }: Props) {
  const { setChapters, clearChapters, saving } = useChapterStore();
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  const handleDelete = async (index: number) => {
    if (!confirm('Delete this chapter? This writes immediately to the database (with backup).')) return;
    setDeletingIndex(index);
    try {
      const updated = chapters.filter((_, i) => i !== index);
      await setChapters(metadataId, updated);
      onSaved?.();
    } catch { /* store has error */ }
    setDeletingIndex(null);
  };

  const handleClear = async () => {
    if (!confirm(`Clear all ${chapters.length} chapters? This writes immediately to the database (with backup).`)) return;
    setClearing(true);
    try {
      await clearChapters(metadataId);
      onSaved?.();
    } catch { /* store has error */ }
    setClearing(false);
  };

  if (chapters.length === 0) {
    return (
      <div className="plex-stage-panel text-center py-8 px-6">
        <p className="text-sm text-white font-semibold">No chapters</p>
        <p className="text-[13px] text-[var(--color-text-muted)] mt-1">Add chapters here if you want the editor to mirror Plex chapter data.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="plex-kicker">
          {chapters.length} chapter{chapters.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={handleClear}
          disabled={saving || clearing}
          className="ctrl-btn text-[11px] px-2 py-0.5 text-red-400/80 hover:text-red-400 hover:border-red-500/30 disabled:opacity-40"
        >
          {clearing ? 'Clearing...' : 'Clear All'}
        </button>
      </div>
      <div className="space-y-1.5 md:space-y-1">
        {chapters.map((chapter, index) => (
          <div
            key={index}
            className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 px-4 py-3 rounded-[20px] border border-white/8 bg-white/5 hover:bg-white/7 hover:border-white/14 transition-colors group backdrop-blur-sm"
          >
            {/* Top row on mobile: number + name + timecodes */}
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
              {/* Chapter number */}
              <div className="flex items-center gap-2 min-w-[50px]">
                <div className="w-1.5 h-1.5 rounded-full bg-violet-500/70" />
                <span className="text-[11px] font-mono text-zinc-500">#{index + 1}</span>
              </div>

              {/* Name */}
              <div className="max-w-[180px] truncate">
                <span className="text-[11px] text-zinc-300">
                  {chapter.name || <span className="text-zinc-500 italic">unnamed</span>}
                </span>
              </div>

              {/* Timecodes */}
              <div className="flex items-center gap-1">
                <span className="timecode text-[11px] text-zinc-300">{formatTime(chapter.start)}</span>
                <span className="text-zinc-500 text-[11px]">&rarr;</span>
                <span className="timecode text-[11px] text-zinc-300">{formatTime(chapter.end)}</span>
                <span className="text-zinc-500 text-[11px] ml-1">({formatTime(chapter.end - chapter.start)})</span>
              </div>
            </div>

            {/* Spacer (desktop) */}
            <div className="hidden sm:block flex-1" />

            {/* Actions — always visible on mobile, hover on desktop */}
            <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => onJump?.(chapter.start)}
                className="ctrl-btn text-[11px] px-2 py-1 sm:py-0.5"
                title="Jump to chapter start"
              >
                &#9654; Jump
              </button>
              <button
                onClick={() => onEdit(index)}
                className="ctrl-btn text-[11px] px-2 py-1 sm:py-0.5"
              >
                Edit
              </button>
              <button
                onClick={() => handleDelete(index)}
                disabled={saving}
                className="ctrl-btn text-[11px] px-2 py-1 sm:py-0.5 text-red-400/80 hover:text-red-400 hover:border-red-500/30 disabled:opacity-40"
              >
                {deletingIndex === index ? '\u2026' : '\u00d7'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
