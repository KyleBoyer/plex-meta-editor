import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { VideoSourceMode } from '@plex-meta-editor/shared';

type VisiblePlaybackMode = Extract<VideoSourceMode, 'direct' | 'plex-api' | 'plex-transcode'>;
type LegacyPlaybackMode = Extract<VideoSourceMode, 'plex-transcode-full' | 'plex-transcode-safe'>;

/** 'auto' = let the player try modes in order; any other value forces that mode only */
export type PlaybackModeOverride = VisiblePlaybackMode | 'auto';

export interface OverlayVisibility {
  intro: boolean;
  commercial: boolean;
  credits: boolean;
  chapterBoundary: boolean;
  episodeBoundary: boolean;
}

export interface OverlayColors {
  intro: string;
  commercial: string;
  credits: string;
  chapterBoundary: string;
  episodeBoundary: string;
}

const DEFAULT_OVERLAY_VISIBILITY: OverlayVisibility = {
  intro: true,
  commercial: true,
  credits: true,
  chapterBoundary: true,
  episodeBoundary: true,
};

export const DEFAULT_OVERLAY_COLORS: OverlayColors = {
  intro: '#22c55e',
  commercial: '#f97316',
  credits: '#3b82f6',
  chapterBoundary: '#a78bfa',
  episodeBoundary: '#ffffff',
};

function normalizePlaybackMode(mode: unknown): PlaybackModeOverride {
  switch (mode) {
    case 'direct':
    case 'plex-api':
    case 'plex-transcode':
    case 'auto':
      return mode;
    case 'plex-transcode-full':
    case 'plex-transcode-safe':
      return 'plex-transcode';
    default:
      return 'auto';
  }
}

interface SettingsState {
  /** Manual playback mode override. 'auto' means try all modes in order. */
  playbackMode: PlaybackModeOverride;
  /** Which marker/boundary overlays are visible on listings and the dock player */
  overlayVisibility: OverlayVisibility;
  /** Custom colors for marker/boundary overlays */
  overlayColors: OverlayColors;

  setPlaybackMode: (mode: PlaybackModeOverride) => void;
  setOverlayVisibility: (key: keyof OverlayVisibility, value: boolean) => void;
  setOverlayColor: (key: keyof OverlayColors, value: string) => void;
  resetOverlayColors: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      playbackMode: 'auto',
      overlayVisibility: { ...DEFAULT_OVERLAY_VISIBILITY },
      overlayColors: { ...DEFAULT_OVERLAY_COLORS },

      setPlaybackMode: (mode) => set({ playbackMode: normalizePlaybackMode(mode) }),

      setOverlayVisibility: (key, value) =>
        set((state) => ({
          overlayVisibility: { ...state.overlayVisibility, [key]: value },
        })),

      setOverlayColor: (key, value) =>
        set((state) => ({
          overlayColors: { ...state.overlayColors, [key]: value },
        })),

      resetOverlayColors: () =>
        set({ overlayColors: { ...DEFAULT_OVERLAY_COLORS } }),
    }),
    {
      name: 'plex-meta-editor-settings',
      version: 5,
      migrate: (persistedState) => {
        const state = (persistedState && typeof persistedState === 'object')
          ? persistedState as {
              playbackMode?: PlaybackModeOverride | LegacyPlaybackMode;
              overlayVisibility?: Partial<OverlayVisibility>;
              overlayColors?: Partial<OverlayColors>;
            }
          : {};
        return {
          playbackMode: normalizePlaybackMode(state.playbackMode),
          overlayVisibility: { ...DEFAULT_OVERLAY_VISIBILITY, ...state.overlayVisibility },
          overlayColors: { ...DEFAULT_OVERLAY_COLORS, ...state.overlayColors },
        };
      },
    },
  ),
);
