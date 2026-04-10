import { create } from 'zustand';
import type { Marker, NewMarker, MarkerType } from '@plex-meta-editor/shared';
import { api } from '../api/client';

interface MarkerState {
  markers: Marker[];
  loading: boolean;
  error: string | null;
  saving: boolean;

  loadMarkers: (metadataId: number) => Promise<void>;
  /**
   * Load markers for a multi-episode group.
   * Plex stores markers at file-relative positions and duplicates them across
   * all episodes sharing a file, so we merge and deduplicate.
   */
  loadMarkersForGroup: (episodeIds: number[]) => Promise<void>;
  addMarker: (marker: NewMarker) => Promise<Marker>;
  editMarker: (id: number, update: { type: MarkerType; start: number; end: number; isFinal: boolean }) => Promise<Marker>;
  deleteMarker: (id: number) => Promise<void>;
  clear: () => void;
}

export const useMarkerStore = create<MarkerState>((set) => ({
  markers: [],
  loading: false,
  error: null,
  saving: false,

  loadMarkers: async (metadataId) => {
    set({ loading: true, error: null });
    try {
      const markers = await api.getMarkers(metadataId);
      set({ markers, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load markers', loading: false });
    }
  },

  loadMarkersForGroup: async (episodeIds) => {
    set({ loading: true, error: null });
    try {
      // Fetch markers for all episodes in parallel
      const allResults = await Promise.all(episodeIds.map(id => api.getMarkers(id)));

      // Plex stores markers at file-relative positions and duplicates them
      // across all episodes sharing the file. Merge and deduplicate by
      // position + type (IDs differ between duplicated markers).
      const seenKeys = new Set<string>();
      const allMarkers: Marker[] = [];

      for (const episodeMarkers of allResults) {
        for (const m of episodeMarkers) {
          const key = `${m.type}-${m.start}-${m.end}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            allMarkers.push(m);
          }
        }
      }

      // Sort by start time
      allMarkers.sort((a, b) => a.start - b.start);

      set({ markers: allMarkers, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load markers', loading: false });
    }
  },

  addMarker: async (marker) => {
    set({ saving: true, error: null });
    try {
      const added = await api.addMarker(marker);
      // Don't reload markers here — the caller (handleSaved) does it
      // with proper multi-episode group awareness.
      set({ saving: false });
      return added;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to add marker', saving: false });
      throw err;
    }
  },

  editMarker: async (id, update) => {
    set({ saving: true, error: null });
    try {
      const edited = await api.editMarker(id, update);
      set({ saving: false });
      return edited;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to edit marker', saving: false });
      throw err;
    }
  },

  deleteMarker: async (id) => {
    set({ saving: true, error: null });
    try {
      await api.deleteMarker(id);
      set({ saving: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete marker', saving: false });
      throw err;
    }
  },

  clear: () => set({ markers: [], loading: false, error: null }),
}));
