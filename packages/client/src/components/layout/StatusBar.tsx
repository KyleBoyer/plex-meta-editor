import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Marker, Chapter } from '@plex-meta-editor/shared';
import { groupEpisodes, useLibraryStore } from '../../stores/library';
import { getPlaybackIdentity, usePlaybackStore, type PlaybackMedia } from '../../stores/playback';
import { useMarkerStore } from '../../stores/markers';
import { useChapterStore } from '../../stores/chapters';
import { useSettingsStore } from '../../stores/settings';
import { useSystemStore } from '../../stores/system';
import { ArtworkImage } from '../media/ArtworkImage';
import { VideoPlayer, type PlaybackStateChange, type VideoPlayerHandle } from '../player/VideoPlayer';
import { BifPreviewTooltip } from './BifPreviewTooltip';

function formatDuration(ms: number): string {
  if (!ms) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPrecise(ms: number): string {
  if (!ms || ms < 0) return '00:00.000';
  const totalSeconds = Math.floor(ms / 1000);
  const millis = Math.round(ms % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ms3 = String(millis).padStart(3, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${ms3}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${ms3}`;
}

function markerLabel(type: string): string {
  if (type === 'intro') return 'Intro';
  if (type === 'credits') return 'Credits';
  if (type === 'commercial') return 'Commercial';
  return type;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function createPlaybackOwnerId(prefix: string): string {
  const uuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `${prefix}-${uuid}`;
}

function TransportButton({
  children,
  onClick,
  title,
  primary = false,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
      title={title}
      className={`plex-transport-button ${primary ? 'plex-transport-button-primary' : ''}`}
    >
      {children}
    </button>
  );
}

function DockProgressBar({
  currentTime,
  duration,
  canSeek,
  onSeek,
  metadataId,
  startOffset,
  markers,
  episodeBoundaries,
  chapters,
}: {
  currentTime: number;
  duration: number;
  canSeek: boolean;
  onSeek: ((ms: number) => void) | null;
  metadataId: number | null;
  startOffset: number;
  markers: Marker[];
  episodeBoundaries: number[];
  chapters: Chapter[];
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; x: number } | null>(null);
  const visibility = useSettingsStore(s => s.overlayVisibility);
  const colors = useSettingsStore(s => s.overlayColors);

  const showTooltip = useCallback((e: React.MouseEvent, text: string) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    setTooltip({ text, x: e.clientX - rect.left });
  }, []);
  const hideTooltip = useCallback(() => setTooltip(null), []);

  const progressRatio = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
  const thumbRatio = hoverRatio ?? progressRatio;
  const showThumb = canSeek && duration > 0 && (dragging || hoverRatio !== null);

  const getRatioFromClientX = useCallback((clientX: number) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  }, []);

  const commitSeek = useCallback((clientX: number) => {
    if (!canSeek || !onSeek || duration <= 0) return;
    const ratio = getRatioFromClientX(clientX);
    setHoverRatio(ratio);
    onSeek(ratio * duration);
  }, [canSeek, duration, getRatioFromClientX, onSeek]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canSeek || !onSeek || duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    commitSeek(event.clientX);
  }, [canSeek, commitSeek, duration, onSeek]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const ratio = getRatioFromClientX(event.clientX);
    setHoverRatio(ratio);
    if (dragging && canSeek && onSeek) {
      onSeek(ratio * duration);
    }
  }, [canSeek, dragging, duration, getRatioFromClientX, onSeek]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    if (!event.currentTarget.matches(':hover')) {
      setHoverRatio(null);
    }
  }, []);

  const handlePointerCancel = useCallback(() => {
    setDragging(false);
    setHoverRatio(null);
  }, []);

  return (
    <div
      ref={trackRef}
      className={`plex-dock-progress-track ${
        canSeek ? 'plex-dock-progress-track-interactive' : ''
      } ${showThumb ? 'plex-dock-progress-track-active' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerEnter={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => {
        if (!dragging) {
          setHoverRatio(null);
        }
      }}
    >
      <div className="plex-dock-progress" style={{ width: `${progressRatio * 100}%` }} />
      {duration > 0 && markers.filter(m => {
        if (m.type === 'intro' && !visibility.intro) return false;
        if (m.type === 'commercial' && !visibility.commercial) return false;
        if (m.type === 'credits' && !visibility.credits) return false;
        return true;
      }).map(marker => {
        const left = (marker.start / duration) * 100;
        const width = ((marker.end - marker.start) / duration) * 100;
        const color = colors[marker.type as keyof typeof colors] || '#888';
        return (
          <div
            key={marker.id}
            className="plex-dock-marker-segment"
            style={{ left: `${left}%`, width: `${width}%`, background: color }}
            onMouseEnter={e => showTooltip(e, `${markerLabel(marker.type)}\n${formatPrecise(marker.start)} – ${formatPrecise(marker.end)}`)}
            onMouseLeave={hideTooltip}
          />
        );
      })}
      {duration > 0 && visibility.episodeBoundary && episodeBoundaries.map((boundary, i) => {
        const pct = (boundary / duration) * 100;
        return (
          <div
            key={`ep-${i}`}
            className="plex-dock-episode-divider"
            style={{ left: `${pct}%`, background: colors.episodeBoundary }}
            onMouseEnter={e => showTooltip(e, `Episode Divider\nat ${formatPrecise(boundary)}`)}
            onMouseLeave={hideTooltip}
          />
        );
      })}
      {duration > 0 && visibility.chapterBoundary && chapters.map((ch, i) => {
        if (i === 0 || ch.start <= 0) return null;
        const pct = (ch.start / duration) * 100;
        const chapterName = ch.name || `Chapter ${i + 1}`;
        const chapterEnd = i < chapters.length - 1 ? chapters[i + 1]?.start ?? ch.end : ch.end;
        return (
          <div
            key={`ch-${i}`}
            className="plex-dock-chapter-divider"
            style={{ left: `${pct}%`, background: colors.chapterBoundary }}
            onMouseEnter={e => showTooltip(e, `Chapter – ${chapterName}\n${formatPrecise(ch.start)} – ${formatPrecise(chapterEnd)}`)}
            onMouseLeave={hideTooltip}
          />
        );
      })}
      {showThumb && (
        <div
          className="plex-dock-progress-thumb plex-dock-progress-thumb-visible"
          style={{ left: `${thumbRatio * 100}%` }}
        />
      )}
      {metadataId != null && (
        <BifPreviewTooltip
          metadataId={metadataId}
          hoverRatio={hoverRatio}
          duration={duration}
          startOffset={startOffset}
          trackRef={trackRef}
        />
      )}
      {tooltip && (
        <div
          className="plex-dock-tooltip"
          style={{ left: `${tooltip.x}px` }}
        >
          {tooltip.text.split('\n').map((line, i) => (
            <div key={i} className={i === 0 ? 'plex-dock-tooltip-title' : 'plex-dock-tooltip-detail'}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function DockMiniPlayer({
  playbackMedia,
  resumeFromMs,
  autoPlayOnLoad,
  sessionVolume,
  sessionMuted,
  sessionPlaybackRate,
}: {
  playbackMedia: PlaybackMedia;
  resumeFromMs: number;
  autoPlayOnLoad: boolean;
  sessionVolume: number;
  sessionMuted: boolean;
  sessionPlaybackRate: number;
}) {
  const syncPlayback = usePlaybackStore(s => s.syncPlayback);
  const detachPlayback = usePlaybackStore(s => s.detachPlayback);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const playbackOwnerIdRef = useRef(createPlaybackOwnerId('dock'));
  const lastSourceKeyRef = useRef<string | null>(null);
  const autoPlayRetryRef = useRef(false);
  const hasEverBeenReadyRef = useRef(false);
  const source = playbackMedia.player;
  const sourceKey = `${source?.src ?? ''}|${source?.sourceType ?? ''}|${source?.startOffset ?? 0}|${source?.episodeDuration ?? 0}`;

  const [currentTime, setCurrentTime] = useState(resumeFromMs);
  const [duration, setDuration] = useState(source?.episodeDuration ?? 0);
  const [isPlaying, setIsPlaying] = useState(autoPlayOnLoad);
  const [volume, setVolume] = useState(sessionVolume);
  const [muted, setMuted] = useState(sessionMuted);
  const [playbackRate, setPlaybackRate] = useState(sessionPlaybackRate);
  const [playerReady, setPlayerReady] = useState(false);
  const latestPlaybackRef = useRef({
    playbackMedia,
    duration: source?.episodeDuration ?? 0,
    currentTime: resumeFromMs,
    isPlaying: autoPlayOnLoad,
    volume: sessionVolume,
    muted: sessionMuted,
    playbackRate: sessionPlaybackRate,
  });

  useLayoutEffect(() => {
    if (lastSourceKeyRef.current === sourceKey) {
      return;
    }

    lastSourceKeyRef.current = sourceKey;
    setCurrentTime(resumeFromMs);
    setDuration(source?.episodeDuration ?? 0);
    setIsPlaying(autoPlayOnLoad);
    setVolume(sessionVolume);
    setMuted(sessionMuted);
    setPlaybackRate(sessionPlaybackRate);
    setPlayerReady(false);
    hasEverBeenReadyRef.current = false;
    autoPlayRetryRef.current = false;
  }, [autoPlayOnLoad, resumeFromMs, sessionMuted, sessionPlaybackRate, sessionVolume, source?.episodeDuration, sourceKey]);

  useEffect(() => {
    latestPlaybackRef.current = {
      playbackMedia,
      duration: duration || source?.episodeDuration || 0,
      currentTime,
      isPlaying,
      volume,
      muted,
      playbackRate,
    };
  }, [currentTime, duration, isPlaying, muted, playbackMedia, playbackRate, source, volume]);

  const handleTogglePlay = useCallback(() => {
    playerRef.current?.togglePlay();
  }, []);

  const handleSeekBy = useCallback((offsetMs: number) => {
    playerRef.current?.seekBy(offsetMs);
  }, []);

  const handleSeekTo = useCallback((ms: number) => {
    playerRef.current?.seekTo(ms);
  }, []);

  const handleStop = useCallback(() => {
    playerRef.current?.stop();
  }, []);

  const handlePlaybackStateChange = useCallback((state: PlaybackStateChange) => {
    if (state.canControl) {
      hasEverBeenReadyRef.current = true;
    }
    setPlayerReady(state.canControl);
    setIsPlaying(state.isPlaying);
    setVolume(state.volume);
    setMuted(state.muted);
    setPlaybackRate(state.playbackRate);
  }, []);

  useEffect(() => {
    if (!playerReady || !autoPlayOnLoad || isPlaying || autoPlayRetryRef.current) {
      return;
    }

    autoPlayRetryRef.current = true;
    playerRef.current?.togglePlay();
  }, [autoPlayOnLoad, isPlaying, playerReady]);

  useEffect(() => {
    if (!source?.src) return;

    // Until the player has loaded, avoid overwriting the store's isPlaying with
    // the dock's uninitialized state — the previous owner's value is still valid.
    const effectiveIsPlaying = hasEverBeenReadyRef.current ? isPlaying : undefined;

    syncPlayback({
      media: playbackMedia,
      ownerId: playbackOwnerIdRef.current,
      canControl: playerReady,
      ...(effectiveIsPlaying !== undefined && { isPlaying: effectiveIsPlaying }),
      currentTime,
      duration: duration || source.episodeDuration || 0,
      volume,
      muted,
      playbackRate,
      togglePlay: playerReady ? handleTogglePlay : null,
      seekBy: playerReady ? handleSeekBy : null,
      seekTo: playerReady ? handleSeekTo : null,
      stop: source?.src ? handleStop : null,
    });
  }, [
    currentTime,
    duration,
    handleSeekBy,
    handleSeekTo,
    handleStop,
    handleTogglePlay,
    isPlaying,
    muted,
    playbackMedia,
    playerReady,
    playbackRate,
    source,
    syncPlayback,
    volume,
  ]);

  useLayoutEffect(() => {
    return () => {
      // If the player was never ready (e.g. StrictMode simulated unmount before
      // the video loaded), skip syncing state from the uninitialized player to
      // the store — the previous owner's state is still valid.
      if (!hasEverBeenReadyRef.current) {
        detachPlayback(playbackOwnerIdRef.current);
        return;
      }

      const snapshot = playerRef.current?.getSyncState();
      const latest = latestPlaybackRef.current;
      const store = usePlaybackStore.getState();
      const latestIdentity = getPlaybackIdentity(latest.playbackMedia);

      if (!latestIdentity || store.ownerId !== playbackOwnerIdRef.current || getPlaybackIdentity(store.media) !== latestIdentity) {
        return;
      }

      if (latest.playbackMedia && snapshot) {
        syncPlayback({
          media: latest.playbackMedia,
          ownerId: playbackOwnerIdRef.current,
          currentTime: snapshot.currentTimeMs,
          isPlaying: snapshot.isPlaying,
          duration: latest.duration,
          volume: snapshot.volume,
          muted: snapshot.muted,
          playbackRate: snapshot.playbackRate,
        });
      } else if (latest.playbackMedia) {
        syncPlayback({
          media: latest.playbackMedia,
          ownerId: playbackOwnerIdRef.current,
          currentTime: latest.currentTime,
          isPlaying: latest.isPlaying,
          duration: latest.duration,
          volume: latest.volume,
          muted: latest.muted,
          playbackRate: latest.playbackRate,
        });
      }

      detachPlayback(playbackOwnerIdRef.current);
    };
  }, [detachPlayback, syncPlayback]);

  if (!source?.src) {
    return null;
  }

  return (
    <VideoPlayer
      key={sourceKey}
      ref={playerRef}
      src={source.src}
      sourceType={source.sourceType}
      frameRate={source.frameRate}
      startOffset={source.startOffset || 0}
      episodeDuration={source.episodeDuration}
      onTimeUpdate={setCurrentTime}
      onDurationChange={setDuration}
      onPlaybackStateChange={handlePlaybackStateChange}
      resumeFromMs={resumeFromMs}
      autoPlayOnLoad={autoPlayOnLoad}
      sessionVolume={volume}
      sessionMuted={muted}
      sessionPlaybackRate={playbackRate}
      layout="surface"
      mediaClassName="w-full h-full object-cover bg-black"
      surfaceClassName="plex-mini-player-surface"
      showMarkerOverlay={false}
      enableGlobalHotkeys={false}
    />
  );
}

function DockMirrorPlayer({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const mediaEl = videoRef.current;
    if (!mediaEl) {
      return undefined;
    }

    if (mediaEl.srcObject !== stream) {
      mediaEl.srcObject = stream;
    }

    const startPlayback = () => {
      void mediaEl.play().catch(() => {});
    };

    startPlayback();
    mediaEl.addEventListener('loadedmetadata', startPlayback);

    return () => {
      mediaEl.removeEventListener('loadedmetadata', startPlayback);
      if (mediaEl.srcObject === stream) {
        mediaEl.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div className="w-full h-full plex-mini-player-surface">
      <video
        ref={videoRef}
        className="w-full h-full object-cover bg-black"
        autoPlay
        muted
        playsInline
        disablePictureInPicture
      />
    </div>
  );
}

export function StatusBar({
  onPreparePlaybackNavigation,
  editorVisible = false,
}: {
  onPreparePlaybackNavigation?: () => void;
  editorVisible?: boolean;
}) {
  const plexConfigured = useSystemStore(s => s.status?.plexConfigured ?? false);

  const selectedLibrary = useLibraryStore(s => s.selectedLibrary);
  const selectedShow = useLibraryStore(s => s.selectedShow);
  const selectedSeason = useLibraryStore(s => s.selectedSeason);
  const selectedEpisodeId = useLibraryStore(s => s.selectedEpisodeId);
  const selectedMovieId = useLibraryStore(s => s.selectedMovieId);
  const selectedEpisodeGroup = useLibraryStore(s => s.selectedEpisodeGroup);
  const episodes = useLibraryStore(s => s.episodes);
  const movies = useLibraryStore(s => s.movies);

  const canControl = usePlaybackStore(s => s.canControl);
  const currentTime = usePlaybackStore(s => s.currentTime);
  const duration = usePlaybackStore(s => s.duration);
  const playbackActive = usePlaybackStore(s => s.active);
  const isPlaying = usePlaybackStore(s => s.isPlaying);
  const volume = usePlaybackStore(s => s.volume);
  const muted = usePlaybackStore(s => s.muted);
  const playbackRate = usePlaybackStore(s => s.playbackRate);
  const mirrorStream = usePlaybackStore(s => s.mirrorStream);
  const togglePlay = usePlaybackStore(s => s.togglePlay);
  const seekBy = usePlaybackStore(s => s.seekBy);
  const seekTo = usePlaybackStore(s => s.seekTo);
  const playbackMedia = usePlaybackStore(s => s.media);
  const stopPlayback = usePlaybackStore(s => s.stopPlayback);

  const selectedEpisode = episodes.find(entry => entry.id === selectedEpisodeId) ?? selectedEpisodeGroup?.[0] ?? null;
  const selectedMovie = movies.find(entry => entry.id === selectedMovieId) ?? null;

  const browseArtworkIds = selectedMovie
    ? [selectedMovie.id]
    : selectedEpisode
      ? [selectedEpisode.id, selectedSeason?.id ?? selectedEpisode.seasonId, selectedShow?.id ?? selectedEpisode.showId]
      : selectedSeason
        ? [selectedSeason.id, selectedShow?.id ?? selectedSeason.showId]
        : selectedShow
          ? [selectedShow.id]
          : [];

  const browseTitle = selectedMovie?.title
    ?? (selectedEpisode ? (selectedEpisode.title?.trim() || `S${selectedEpisode.seasonIndex} \u00B7 E${String(selectedEpisode.index).padStart(2, '0')}`) : null)
    ?? selectedSeason?.title
    ?? selectedShow?.title
    ?? 'Metadata Editor';

  const browseSubtitle = selectedMovie
    ? `${selectedMovie.year || 'Movie'} • ${formatDuration(selectedMovie.fileDuration || selectedMovie.duration)}`
    : selectedEpisode
      ? `${selectedEpisode.showTitle} • S${selectedEpisode.seasonIndex} • E${String(selectedEpisode.index).padStart(2, '0')}`
      : selectedSeason
        ? `${selectedSeason.showTitle} • ${selectedSeason.episodeCount} episodes`
        : selectedShow
          ? `${selectedShow.seasonCount} seasons • ${selectedShow.episodeCount} episodes`
          : selectedLibrary
            ? `Browsing ${selectedLibrary.name}`
            : 'Browse a library and open any title to start editing markers.';

  const browseMeta = selectedMovie
    ? 'Movie workspace'
    : selectedEpisode
      ? 'Episode editor'
      : selectedSeason
        ? 'Season browser'
        : selectedShow
          ? 'Show browser'
          : plexConfigured
            ? 'Plex artwork and playback ready'
            : 'Local database mode';

  const isOnPlaybackTarget = useMemo(() => {
    if (!editorVisible) return false;
    if (!playbackMedia?.target) return false;
    if (playbackMedia.target.movieId) {
      return playbackMedia.target.movieId === selectedMovieId;
    }
    if (playbackMedia.target.episodeId) {
      return playbackMedia.target.episodeId === selectedEpisodeId;
    }
    return false;
  }, [editorVisible, playbackMedia, selectedEpisodeId, selectedMovieId]);

  const handleOpenPlaybackTarget = useCallback(async () => {
    const target = playbackMedia?.target;
    if (!target) return;

    onPreparePlaybackNavigation?.();

    const store = useLibraryStore.getState();
    if (!store.libraries.length) {
      await store.loadLibraries();
    }

    const latest = useLibraryStore.getState();
    const library = latest.libraries.find(entry => entry.id === target.library.id) ?? target.library;

    if (latest.selectedLibrary?.id !== library.id) {
      await useLibraryStore.getState().selectLibrary(library);
    }

    if (target.movieId) {
      useLibraryStore.getState().selectMovie(target.movieId);
      return;
    }

    if (target.show && useLibraryStore.getState().selectedShow?.id !== target.show.id) {
      await useLibraryStore.getState().selectShow(target.show);
    }

    if (target.season && useLibraryStore.getState().selectedSeason?.id !== target.season.id) {
      await useLibraryStore.getState().selectSeason(target.season);
    }

    if (target.episodeId) {
      const grouped = groupEpisodes(useLibraryStore.getState().episodes);
      const group = grouped.find(entry => entry.episodes.some(episode => episode.id === target.episodeId));
      if (group) {
        useLibraryStore.getState().selectEpisodeGroup(group);
      } else {
        useLibraryStore.getState().selectEpisode(target.episodeId);
      }
    }
  }, [onPreparePlaybackNavigation, playbackMedia]);

  const handleSkipNext = useCallback(() => {
    // Episodes: find next episode in the current season
    if (selectedEpisode && episodes.length) {
      const currentIndex = episodes.findIndex(ep => ep.id === selectedEpisode.id);
      if (currentIndex >= 0 && currentIndex < episodes.length - 1) {
        const nextEp = episodes[currentIndex + 1];
        const grouped = groupEpisodes(episodes);
        const group = grouped.find(g => g.episodes.some(ep => ep.id === nextEp.id));
        if (group) {
          useLibraryStore.getState().selectEpisodeGroup(group);
        } else {
          useLibraryStore.getState().selectEpisode(nextEp.id);
        }
        return;
      }
    }

    // Movies: find next movie alphabetically
    if (selectedMovie && movies.length) {
      const sorted = [...movies].sort((a, b) => a.title.localeCompare(b.title));
      const currentIndex = sorted.findIndex(m => m.id === selectedMovie.id);
      if (currentIndex >= 0 && currentIndex < sorted.length - 1) {
        useLibraryStore.getState().selectMovie(sorted[currentIndex + 1].id);
        return;
      }
    }

    stopPlayback();
  }, [selectedEpisode, selectedMovie, episodes, movies, stopPlayback]);

  const handleSkipPrev = useCallback(() => {
    // Episodes: find previous episode in the current season
    if (selectedEpisode && episodes.length) {
      const currentIndex = episodes.findIndex(ep => ep.id === selectedEpisode.id);
      if (currentIndex > 0) {
        const prevEp = episodes[currentIndex - 1];
        const grouped = groupEpisodes(episodes);
        const group = grouped.find(g => g.episodes.some(ep => ep.id === prevEp.id));
        if (group) {
          useLibraryStore.getState().selectEpisodeGroup(group);
        } else {
          useLibraryStore.getState().selectEpisode(prevEp.id);
        }
        return;
      }
    }

    // Movies: find previous movie alphabetically
    if (selectedMovie && movies.length) {
      const sorted = [...movies].sort((a, b) => a.title.localeCompare(b.title));
      const currentIndex = sorted.findIndex(m => m.id === selectedMovie.id);
      if (currentIndex > 0) {
        useLibraryStore.getState().selectMovie(sorted[currentIndex - 1].id);
        return;
      }
    }
  }, [selectedEpisode, selectedMovie, episodes, movies]);

  const artworkIds = playbackMedia?.artworkIds ?? browseArtworkIds;
  const title = playbackMedia?.title ?? browseTitle;
  const subtitle = playbackMedia?.subtitle ?? browseSubtitle;

  const meta = canControl
    ? `${formatDuration(currentTime)} / ${formatDuration(duration)}`
    : playbackMedia
      ? duration > 0
        ? `${formatDuration(currentTime)} / ${formatDuration(duration)}`
        : 'Ready to resume'
      : browseMeta;

  const showSeekTransport = canControl && Boolean(seekBy);
  const showPlayTransport = canControl && Boolean(togglePlay);
  const canScrub = canControl && Boolean(seekTo) && duration > 0;
  const showMirrorMiniPlayer = Boolean(playbackActive && playbackMedia?.player?.src && mirrorStream && isOnPlaybackTarget);
  const showStandaloneMiniPlayer = Boolean(playbackActive && playbackMedia?.player?.src) && !showMirrorMiniPlayer && !isOnPlaybackTarget;
  const canOpenPlaybackTarget = Boolean(playbackMedia?.target) && !isOnPlaybackTarget;
  const showDock = Boolean(playbackActive && playbackMedia);

  const markers = useMarkerStore(s => s.markers);
  const chapters = useChapterStore(s => s.chapters);

  // Compute episode boundaries for multi-episode files
  const episodeBoundaries = useMemo(() => {
    if (!selectedEpisodeGroup || selectedEpisodeGroup.length <= 1 || duration <= 0) return [];
    const boundaries: number[] = [];
    let cumulative = 0;
    for (let i = 0; i < selectedEpisodeGroup.length - 1; i++) {
      cumulative += selectedEpisodeGroup[i].duration;
      boundaries.push(cumulative);
    }
    return boundaries;
  }, [selectedEpisodeGroup, duration]);

  // Find the marker the playhead is currently inside (for skip button)
  const activeMarker = useMemo(() => {
    if (!canControl || duration <= 0) return null;
    return markers.find(m => currentTime >= m.start && currentTime < m.end) ?? null;
  }, [markers, currentTime, canControl, duration]);

  const skipLabel = activeMarker
    ? activeMarker.type === 'intro' ? 'Skip Intro'
    : activeMarker.type === 'credits' ? 'Skip Credits'
    : 'Skip Commercial'
    : null;

  if (!showDock) {
    return null;
  }

  return (
    <footer className="plex-dock shrink-0">
      <DockProgressBar
        currentTime={currentTime}
        duration={duration}
        canSeek={canScrub}
        onSeek={seekTo}
        metadataId={playbackMedia?.target?.episodeId ?? playbackMedia?.target?.movieId ?? null}
        startOffset={playbackMedia?.player?.startOffset ?? 0}
        markers={markers}
        episodeBoundaries={episodeBoundaries}
        chapters={chapters}
      />

      <div className="plex-dock-body">
        {/* Left: poster + info */}
        <div className="plex-dock-left">
          <button
            type="button"
            onClick={() => { void handleOpenPlaybackTarget(); }}
            disabled={!canOpenPlaybackTarget}
            className="plex-dock-open group cursor-pointer"
            title="Open editor"
          >
            <div className={`plex-mini-poster shrink-0 ${showMirrorMiniPlayer || showStandaloneMiniPlayer ? 'plex-mini-poster-live' : ''}`}>
              {showMirrorMiniPlayer && mirrorStream ? (
                <DockMirrorPlayer stream={mirrorStream} />
              ) : showStandaloneMiniPlayer && playbackMedia ? (
                <DockMiniPlayer
                  playbackMedia={playbackMedia}
                  resumeFromMs={currentTime}
                  autoPlayOnLoad={isPlaying}
                  sessionVolume={volume}
                  sessionMuted={muted}
                  sessionPlaybackRate={playbackRate}
                />
              ) : (
                <ArtworkImage
                  metadataIds={artworkIds}
                  alt={title}
                  className="plex-mini-poster-image"
                  fallback={<div className="plex-artwork-fallback plex-artwork-fallback-soft" />}
                />
              )}
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => { void handleOpenPlaybackTarget(); }}
            disabled={!canOpenPlaybackTarget}
            className="plex-dock-copy"
            title={canOpenPlaybackTarget ? 'Open this editor again' : undefined}
          >
            <div className="plex-dock-title truncate">{title}</div>
            <div className="plex-dock-subtitle truncate">{subtitle}</div>
            <div className="plex-dock-meta">{meta}</div>
          </button>
        </div>

        {activeMarker && seekTo && (
          <button
            type="button"
            className="plex-skip-marker-btn"
            onClick={e => { e.stopPropagation(); seekTo(activeMarker.end); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 5v14l11-7L5 5Z" /><rect x="17" y="5" width="3" height="14" /></svg>
            {skipLabel}
          </button>
        )}

        {/* Center: transport controls */}
        <div className="plex-dock-center">
          <div className="plex-transport-left">
            {canControl && (
              <TransportButton onClick={handleSkipPrev} title="Previous">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="5" width="3" height="14" /><path d="M19 19 8 12l11-7v14Z" /></svg>
              </TransportButton>
            )}

            {showSeekTransport && seekBy && (
              <TransportButton onClick={() => seekBy(-10000)} title="Back 10 seconds">
                <span className="plex-skip-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                  <span className="plex-skip-label">10</span>
                </span>
              </TransportButton>
            )}
          </div>

          {showPlayTransport && togglePlay && (
            <TransportButton onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'} primary>
              {isPlaying ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4Zm8 0h4v16h-4V4Z" /></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="m7 4 13 8-13 8V4Z" /></svg>
              )}
            </TransportButton>
          )}

          <div className="plex-transport-right">
            {showSeekTransport && seekBy && (
              <TransportButton onClick={() => seekBy(30000)} title="Forward 30 seconds">
                <span className="plex-skip-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                  <span className="plex-skip-label">30</span>
                </span>
              </TransportButton>
            )}

            {canControl && (
              <TransportButton onClick={handleSkipNext} title="Next">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 5v14l11-7L5 5Z" /><rect x="17" y="5" width="3" height="14" /></svg>
              </TransportButton>
            )}

            <TransportButton onClick={stopPlayback} title="Stop">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>
            </TransportButton>
          </div>
        </div>

        {/* Right: volume */}
        <div className="plex-dock-right">
          <div className="plex-volume-control">
            <TransportButton onClick={() => {
              const player = document.querySelector('video');
              if (player) player.muted = !player.muted;
            }} title={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
              )}
            </TransportButton>
            <div className="plex-volume-slider-wrap">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={muted ? 0 : volume}
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  const player = document.querySelector('video');
                  if (player) {
                    player.volume = val;
                    player.muted = val === 0;
                  }
                }}
                className="plex-volume-slider"
                style={{ '--vol': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                title={`Volume: ${Math.round((muted ? 0 : volume) * 100)}%`}
              />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
