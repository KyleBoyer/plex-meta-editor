import { create } from 'zustand';
import type { Chapter } from '@plex-meta-editor/shared';
import { api } from '../api/client';

interface ChapterState {
  chapters: Chapter[];
  loading: boolean;
  error: string | null;
  saving: boolean;

  loadChapters: (metadataId: number) => Promise<void>;
  setChapters: (metadataId: number, chapters: Chapter[]) => Promise<void>;
  clearChapters: (metadataId: number) => Promise<void>;
  clear: () => void;
}

export const useChapterStore = create<ChapterState>((set) => ({
  chapters: [],
  loading: false,
  error: null,
  saving: false,

  loadChapters: async (metadataId) => {
    set({ loading: true, error: null });
    try {
      const data = await api.getChapters(metadataId);
      set({ chapters: data.chapters, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load chapters', loading: false });
    }
  },

  setChapters: async (metadataId, chapters) => {
    set({ saving: true, error: null });
    try {
      const data = await api.setChapters(metadataId, chapters);
      set({ chapters: data.chapters, saving: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save chapters', saving: false });
      throw err;
    }
  },

  clearChapters: async (metadataId) => {
    set({ saving: true, error: null });
    try {
      await api.clearChapters(metadataId);
      set({ chapters: [], saving: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to clear chapters', saving: false });
      throw err;
    }
  },

  clear: () => set({ chapters: [], loading: false, error: null }),
}));
