import { create } from 'zustand';
import type { SystemStatus } from '@plex-meta-editor/shared';
import { api } from '../api/client';

interface SystemState {
  status: SystemStatus | null;
  loading: boolean;
  error: string | null;

  loadStatus: () => Promise<void>;
}

export const useSystemStore = create<SystemState>((set) => ({
  status: null,
  loading: false,
  error: null,

  loadStatus: async () => {
    set({ loading: true, error: null });
    try {
      const status = await api.getStatus();
      set({ status, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load system status' });
    }
  },
}));
