import { create } from 'zustand';
import type { Library, Season, Show } from '@plex-meta-editor/shared';

type TogglePlayHandler = (() => void) | null;
type SeekByHandler = ((offsetMs: number) => void) | null;
type SeekToHandler = ((ms: number) => void) | null;
type StopHandler = (() => void) | null;

export interface PlaybackTarget {
  library: Library;
  show?: Show | null;
  season?: Season | null;
  episodeId?: number | null;
  movieId?: number | null;
}

export interface PlaybackPlayerSource {
  src: string;
  sourceType: string;
  frameRate?: number | null;
  startOffset?: number;
  episodeDuration?: number;
}

export interface PlaybackMedia {
  artworkIds: number[];
  title: string;
  subtitle: string;
  target: PlaybackTarget;
  player: PlaybackPlayerSource | null;
}

interface PlaybackSnapshot {
  active: boolean;
  canControl: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  mirrorStream: MediaStream | null;
  ownerId: string | null;
  togglePlay: TogglePlayHandler;
  seekBy: SeekByHandler;
  seekTo: SeekToHandler;
  stop: StopHandler;
  media: PlaybackMedia | null;
}

interface PlaybackState extends PlaybackSnapshot {
  dismissedIdentity: string | null;
  syncPlayback: (snapshot: Partial<PlaybackSnapshot>) => void;
  detachPlayback: (ownerId?: string | null) => void;
  stopPlayback: () => void;
  clearPlayback: () => void;
}

const INITIAL_PLAYBACK_STATE: PlaybackSnapshot = {
  active: false,
  canControl: false,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  playbackRate: 1,
  mirrorStream: null,
  ownerId: null,
  togglePlay: null,
  seekBy: null,
  seekTo: null,
  stop: null,
  media: null,
};

function releaseMirrorStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach(track => track.stop());
}

export function getPlaybackIdentity(media: PlaybackMedia | null): string | null {
  if (!media) return null;

  if (media.target.movieId != null) {
    return `movie:${media.target.library.id}:${media.target.movieId}`;
  }

  if (media.target.episodeId != null) {
    return `episode:${media.target.library.id}:${media.target.episodeId}`;
  }

  if (media.target.season?.id != null) {
    return `season:${media.target.library.id}:${media.target.season.id}`;
  }

  if (media.target.show?.id != null) {
    return `show:${media.target.library.id}:${media.target.show.id}`;
  }

  return media.player?.src ? `src:${media.player.src}` : null;
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  ...INITIAL_PLAYBACK_STATE,
  dismissedIdentity: null,
  syncPlayback: snapshot => set(current => {
    const next = { ...current, ...snapshot };
    const currentIdentity = getPlaybackIdentity(current.media);
    const nextIdentity = getPlaybackIdentity(next.media);

    if (!next.media) {
      next.active = false;
      next.dismissedIdentity = null;
      next.mirrorStream = null;
      next.ownerId = null;
    } else if (next.isPlaying) {
      next.active = true;
      if (next.dismissedIdentity === nextIdentity) {
        next.dismissedIdentity = null;
      }
    } else if (nextIdentity !== currentIdentity) {
      next.active = true;
      if (next.dismissedIdentity === nextIdentity) {
        next.dismissedIdentity = null;
      }
    } else if (current.active) {
      next.active = true;
    } else if (next.dismissedIdentity === nextIdentity) {
      next.active = false;
    } else {
      next.active = false;
    }

    const mirrorStreamChanged = current.mirrorStream !== next.mirrorStream;
    if (mirrorStreamChanged) {
      releaseMirrorStream(current.mirrorStream);
    }

    const changed = (
      current.active !== next.active
      || current.canControl !== next.canControl
      || current.isPlaying !== next.isPlaying
      || current.currentTime !== next.currentTime
      || current.duration !== next.duration
      || current.volume !== next.volume
      || current.muted !== next.muted
      || current.playbackRate !== next.playbackRate
      || current.mirrorStream !== next.mirrorStream
      || current.ownerId !== next.ownerId
      || current.togglePlay !== next.togglePlay
      || current.seekBy !== next.seekBy
      || current.seekTo !== next.seekTo
      || current.stop !== next.stop
      || current.media !== next.media
      || current.dismissedIdentity !== next.dismissedIdentity
    );

    return changed ? next : current;
  }),
  detachPlayback: ownerId => {
    if (ownerId && get().ownerId !== ownerId) {
      return;
    }

    releaseMirrorStream(get().mirrorStream);

    set(current => ({
      ...current,
      canControl: false,
      mirrorStream: null,
      ownerId: null,
      togglePlay: null,
      seekBy: null,
      seekTo: null,
      stop: null,
    }));
  },
  stopPlayback: () => {
    get().stop?.();
    releaseMirrorStream(get().mirrorStream);

    set(current => ({
      ...current,
      active: false,
      canControl: false,
      isPlaying: false,
      currentTime: 0,
      mirrorStream: null,
      ownerId: null,
      togglePlay: null,
      seekBy: null,
      seekTo: null,
      stop: null,
      dismissedIdentity: getPlaybackIdentity(current.media),
    }));
  },
  clearPlayback: () => {
    releaseMirrorStream(get().mirrorStream);

    set({
      ...INITIAL_PLAYBACK_STATE,
      dismissedIdentity: null,
    });
  },
}));
