import { create } from 'zustand';
import type { SessionStatus, WriteHistoryEntry } from '@plex-meta-editor/shared';
import { api } from '../api/client';

interface SessionState {
  status: SessionStatus | null;
  writeHistory: WriteHistoryEntry[];
  loading: boolean;

  loadSession: () => Promise<void>;
  loadWriteHistory: () => Promise<void>;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: null,
  writeHistory: [],
  loading: false,

  loadSession: async () => {
    set({ loading: true });
    try {
      const status = await api.getSession();
      set({ status, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  loadWriteHistory: async () => {
    try {
      const writeHistory = await api.getWriteHistory();
      set({ writeHistory });
    } catch {
      // silently fail
    }
  },
}));
