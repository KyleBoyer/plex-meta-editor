import { attachMediaElement, createPlayer, mediaProps, useComposedRefs, useMediaInstance } from '@videojs/react';
import { Video, VideoSkin, videoFeatures } from '@videojs/react/video';
import '@videojs/react/video/skin.css';
import { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo, forwardRef, useImperativeHandle, memo, type PointerEvent as ReactPointerEvent, type RefObject, type SyntheticEvent, type VideoHTMLAttributes } from 'react';
import type { HlsVideoProps } from '@videojs/react/media/hls-video';
import type { NativeHlsVideoProps } from '@videojs/react/media/native-hls-video';
import { HlsMedia, HlsMediaDelegate } from '@videojs/core/dom/media/hls';
import { NativeHlsMedia, NativeHlsMediaDelegate } from '@videojs/core/dom/media/native-hls';
import type { Marker, Chapter } from '@plex-meta-editor/shared';
import { MarkerOverlay } from './MarkerOverlay';
import type { EpisodeBoundary } from './PlayerTimeline';
import { useSettingsStore } from '../../stores/settings';

export interface VideoPlayerHandle {
  seekTo: (ms: number) => void;
  getCurrentTime: () => number;
  togglePlay: () => void;
  seekBy: (offsetMs: number) => void;
  stop: () => void;
  getSyncState: () => PlaybackSyncState;
  getMirrorStream: () => MediaStream | null;
}

export interface PlaybackFailureContext {
  attemptedToPlay: boolean;
  currentTimeMs: number;
}

export interface PlaybackStateChange {
  canControl: boolean;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
}

export interface PlaybackSyncState {
  currentTimeMs: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
}

interface Props {
  src: string;
  /** MIME type for the source — 'application/x-mpegURL' for HLS, 'video/mp4' otherwise */
  sourceType?: string;
  frameRate?: number | null;
  markers?: Marker[];
  chapters?: Chapter[];
  codecWarning?: string | null;
  startOffset?: number;
  episodeDuration?: number;
  episodeBoundaries?: EpisodeBoundary[];
  onBoundaryDrag?: (index: number, newPosition: number) => void;
  onTimeUpdate?: (ms: number) => void;
  onSetStart?: (ms: number) => void;
  onSetEnd?: (ms: number) => void;
  onDurationChange?: (ms: number) => void;
  resumeFromMs?: number | null;
  autoPlayOnLoad?: boolean;
  sessionVolume?: number | null;
  sessionMuted?: boolean | null;
  sessionPlaybackRate?: number | null;
  onPlaybackStateChange?: (state: PlaybackStateChange) => void;
  onPlaybackFailed?: (context: PlaybackFailureContext) => void;
  layout?: 'full' | 'surface';
  mediaClassName?: string;
  surfaceClassName?: string;
  showMarkerOverlay?: boolean;
  enableGlobalHotkeys?: boolean;
}

const DEFAULT_FRAME_STEP_MS = 42;
const FRAME_HOLD_INITIAL_DELAY_MS = 350;
const FRAME_HOLD_TICK_MS = 50;
const FRAME_HOLD_START_SPEED_MULTIPLIER = 1;
const FRAME_HOLD_MAX_SPEED_MULTIPLIER = 10;
const FRAME_HOLD_ACCELERATION_DURATION_MS = 2200;
const STALL_TIMEOUT_MS = 20000;
const SKIP_MARKER_EPSILON_MS = 1;
const HLS_MIME_TYPES = new Set(['application/x-mpegurl', 'application/vnd.apple.mpegurl']);

const ReactVideoPlayer = createPlayer({ features: videoFeatures });

type FrameHoldSource = 'button-prev' | 'button-next' | 'key-prev' | 'key-next';
type PlayerMediaElementProps = {
  className: NonNullable<VideoHTMLAttributes<HTMLVideoElement>['className']>;
  playsInline: true;
  preload: 'auto' | 'metadata' | 'none';
  crossOrigin: 'anonymous' | 'use-credentials';
  onPlay: VideoHTMLAttributes<HTMLVideoElement>['onPlay'];
  onPause: VideoHTMLAttributes<HTMLVideoElement>['onPause'];
  onEnded: VideoHTMLAttributes<HTMLVideoElement>['onEnded'];
  onTimeUpdate: VideoHTMLAttributes<HTMLVideoElement>['onTimeUpdate'];
  onDurationChange: VideoHTMLAttributes<HTMLVideoElement>['onDurationChange'];
  onLoadedMetadata: VideoHTMLAttributes<HTMLVideoElement>['onLoadedMetadata'];
  onCanPlay: VideoHTMLAttributes<HTMLVideoElement>['onCanPlay'];
  onVolumeChange: VideoHTMLAttributes<HTMLVideoElement>['onVolumeChange'];
  onRateChange: VideoHTMLAttributes<HTMLVideoElement>['onRateChange'];
  onWaiting: VideoHTMLAttributes<HTMLVideoElement>['onWaiting'];
  onStalled: VideoHTMLAttributes<HTMLVideoElement>['onStalled'];
  onError: VideoHTMLAttributes<HTMLVideoElement>['onError'];
};

type CaptureStreamCapableVideoElement = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

function getFrameStepMs(frameRate?: number | null): number {
  if (typeof frameRate === 'number' && Number.isFinite(frameRate) && frameRate > 0.1 && frameRate <= 1000) {
    return 1000 / frameRate;
  }

  return DEFAULT_FRAME_STEP_MS;
}

function normalizeVolume(volume?: number | null): number {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) {
    return 1;
  }

  return Math.min(Math.max(volume, 0), 1);
}

function normalizePlaybackRate(playbackRate?: number | null): number {
  if (typeof playbackRate !== 'number' || !Number.isFinite(playbackRate) || playbackRate <= 0) {
    return 1;
  }

  return playbackRate;
}

function browserSupportsNativeHls(): boolean {
  if (typeof document === 'undefined') return false;

  const videoEl = document.createElement('video');
  if (typeof videoEl.canPlayType !== 'function') return false;

  return Boolean(
    videoEl.canPlayType('application/vnd.apple.mpegurl')
    || videoEl.canPlayType('application/x-mpegurl'),
  );
}

function shouldPreferNativeHls(): boolean {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent;
  const isIOSWebKit = /iPhone|iPad|iPod/i.test(ua);
  const isDesktopSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Brave/i.test(ua);

  // Chromium reports "maybe" for HLS MIME types on macOS, but reliable app
  // playback still needs hls.js there. Restrict native HLS to Safari/WebKit.
  return browserSupportsNativeHls() && (isIOSWebKit || isDesktopSafari);
}

const StableHlsVideo = memo(forwardRef<HTMLVideoElement, HlsVideoProps>(function StableHlsVideo({ children, ...props }, ref) {
  const mediaApi = useMediaInstance(HlsMedia);
  const attachRef = useMemo(() => attachMediaElement<HTMLVideoElement>(mediaApi), [mediaApi]);

  return (
    <video
      ref={useComposedRefs(attachRef, ref)}
      {...mediaProps(mediaApi, HlsMediaDelegate, props)}
    >
      {children}
    </video>
  );
}));

StableHlsVideo.displayName = 'StableHlsVideo';

const StableNativeHlsVideo = memo(forwardRef<HTMLVideoElement, NativeHlsVideoProps>(function StableNativeHlsVideo({ children, ...props }, ref) {
  const mediaApi = useMediaInstance(NativeHlsMedia);
  const attachRef = useMemo(() => attachMediaElement<HTMLVideoElement>(mediaApi), [mediaApi]);

  return (
    <video
      ref={useComposedRefs(attachRef, ref)}
      {...mediaProps(mediaApi, NativeHlsMediaDelegate, props)}
    >
      {children}
    </video>
  );
}));

StableNativeHlsVideo.displayName = 'StableNativeHlsVideo';

interface PlayerSurfaceProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  mediaKey: string;
  src: string;
  sourceType: string;
  isHlsSource: boolean;
  supportsNativeHls: boolean;
  mediaElementProps: PlayerMediaElementProps;
  withSkin?: boolean;
}

const PlayerSurface = memo(function PlayerSurface({
  videoRef,
  mediaKey,
  src,
  sourceType,
  isHlsSource,
  supportsNativeHls,
  mediaElementProps,
  withSkin = true,
}: PlayerSurfaceProps) {
  const mediaNode = isHlsSource ? (
    supportsNativeHls ? (
      <StableNativeHlsVideo
        key={mediaKey}
        ref={videoRef}
        {...mediaElementProps}
        src={src}
      />
    ) : (
      <StableHlsVideo
        key={mediaKey}
        ref={videoRef}
        {...mediaElementProps}
        src={src}
        type={sourceType}
      />
    )
  ) : (
    <Video
      key={mediaKey}
      ref={videoRef}
      {...mediaElementProps}
    >
      <source src={src} type={sourceType} />
    </Video>
  );

  return (
    <div className="w-full h-full pb-px md:pb-0">
      <ReactVideoPlayer.Provider>
        {withSkin ? (
          <VideoSkin className="w-full h-full">
            {mediaNode}
          </VideoSkin>
        ) : mediaNode}
      </ReactVideoPlayer.Provider>
    </div>
  );
});

PlayerSurface.displayName = 'PlayerSurface';

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  {
    src,
    sourceType = 'video/mp4',
    frameRate,
    markers = [],
    chapters = [],
    codecWarning,
    startOffset = 0,
    episodeDuration,
    episodeBoundaries,
    onBoundaryDrag,
    onTimeUpdate,
    onSetStart,
    onSetEnd,
    onDurationChange,
    resumeFromMs = null,
    autoPlayOnLoad = false,
    sessionVolume = 1,
    sessionMuted = false,
    sessionPlaybackRate = 1,
    onPlaybackStateChange,
    onPlaybackFailed,
    layout = 'full',
    mediaClassName = 'w-full h-full object-contain bg-black',
    surfaceClassName = '',
    showMarkerOverlay = layout === 'full',
    enableGlobalHotkeys = true,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const overlayColors = useSettingsStore(s => s.overlayColors);

  const latestRef = useRef({ startOffset, episodeDuration, onTimeUpdate, onDurationChange });
  useEffect(() => { latestRef.current = { startOffset, episodeDuration, onTimeUpdate, onDurationChange }; });

  const onPlaybackFailedRef = useRef(onPlaybackFailed);
  useEffect(() => { onPlaybackFailedRef.current = onPlaybackFailed; }, [onPlaybackFailed]);

  const onPlaybackStateChangeRef = useRef(onPlaybackStateChange);
  useEffect(() => { onPlaybackStateChangeRef.current = onPlaybackStateChange; }, [onPlaybackStateChange]);

  const resumeRef = useRef({ resumeFromMs, autoPlayOnLoad });
  useEffect(() => {
    resumeRef.current = { resumeFromMs, autoPlayOnLoad };
  }, [resumeFromMs, autoPlayOnLoad]);

  const sessionRef = useRef({
    volume: normalizeVolume(sessionVolume),
    muted: Boolean(sessionMuted),
    playbackRate: normalizePlaybackRate(sessionPlaybackRate),
  });
  const lastSyncStateRef = useRef<PlaybackSyncState>({
    currentTimeMs: Math.max(0, resumeFromMs ?? 0),
    isPlaying: Boolean(autoPlayOnLoad),
    volume: normalizeVolume(sessionVolume),
    muted: Boolean(sessionMuted),
    playbackRate: normalizePlaybackRate(sessionPlaybackRate),
  });
  const mirrorStreamRef = useRef<MediaStream | null>(null);
  const isTearingDownRef = useRef(false);
  useEffect(() => {
    isTearingDownRef.current = false;
    sessionRef.current = {
      volume: normalizeVolume(sessionVolume),
      muted: Boolean(sessionMuted),
      playbackRate: normalizePlaybackRate(sessionPlaybackRate),
    };
  }, [sessionMuted, sessionPlaybackRate, sessionVolume]);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasError, setHasError] = useState(false);
  const [stallError, setStallError] = useState(false);
  const hasProgressRef = useRef(false);
  const hasSeenLoadRef = useRef(false);
  const playIntentRef = useRef(false);
  const hasIssuedAutoplayRef = useRef(false);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameHoldStartAtRef = useRef<number | null>(null);
  const frameHoldLastTickAtRef = useRef<number | null>(null);
  const frameHoldCarryMsRef = useRef(0);
  const frameHoldSourceRef = useRef<FrameHoldSource | null>(null);
  const frameHoldDirectionRef = useRef<1 | -1 | null>(null);
  const frameHoldHasRepeatedRef = useRef(false);
  const suppressFrameClickRef = useRef<1 | -1 | null>(null);
  const [scrubBoundaryDrag, setScrubBoundaryDrag] = useState<number | null>(null);
  const frameStepMs = getFrameStepMs(frameRate);
  const supportsNativeHls = useMemo(() => shouldPreferNativeHls(), []);
  const normalizedSourceType = sourceType.toLowerCase();
  const isHlsSource = HLS_MIME_TYPES.has(normalizedSourceType);
  const mediaKey = `${isHlsSource ? (supportsNativeHls ? 'native-hls' : 'hls') : 'video'}:${normalizedSourceType}:${src}`;

  const clearFrameHoldTimer = useCallback(() => {
    if (frameHoldTimerRef.current) {
      clearTimeout(frameHoldTimerRef.current);
      frameHoldTimerRef.current = null;
    }
    frameHoldStartAtRef.current = null;
    frameHoldLastTickAtRef.current = null;
    frameHoldCarryMsRef.current = 0;
    frameHoldSourceRef.current = null;
    frameHoldDirectionRef.current = null;
  }, []);

  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  const readSyncState = useCallback((mediaEl?: HTMLVideoElement | null): PlaybackSyncState => {
    if (isTearingDownRef.current) {
      return lastSyncStateRef.current;
    }

    const target = mediaEl ?? videoRef.current;

    if (!target) {
      return lastSyncStateRef.current;
    }

    return {
      currentTimeMs: Math.max(0, ((target.currentTime ?? 0) * 1000) - startOffset),
      isPlaying: Boolean(!target.ended && (playIntentRef.current || !target.paused)),
      volume: normalizeVolume(target.volume),
      muted: target.muted,
      playbackRate: normalizePlaybackRate(target.playbackRate),
    };
  }, [startOffset]);

  const updateLastSyncState = useCallback((mediaEl?: HTMLVideoElement | null): PlaybackSyncState => {
    const nextState = readSyncState(mediaEl);
    lastSyncStateRef.current = nextState;
    return nextState;
  }, [readSyncState]);

  const releaseMirrorStream = useCallback(() => {
    mirrorStreamRef.current?.getTracks().forEach(track => track.stop());
    mirrorStreamRef.current = null;
  }, []);

  const emitPlaybackState = useCallback((canControl: boolean, mediaEl?: HTMLVideoElement | null) => {
    const syncState = isTearingDownRef.current
      ? lastSyncStateRef.current
      : mediaEl ?? videoRef.current
        ? updateLastSyncState(mediaEl)
        : lastSyncStateRef.current;

    onPlaybackStateChangeRef.current?.({
      canControl,
      isPlaying: syncState.isPlaying,
      volume: syncState.volume,
      muted: syncState.muted,
      playbackRate: syncState.playbackRate,
    });
  }, [updateLastSyncState]);

  const applySessionSettings = useCallback((mediaEl?: HTMLVideoElement | null) => {
    const target = mediaEl ?? videoRef.current;
    if (!target) return;

    const session = sessionRef.current;

    if (Math.abs(target.volume - session.volume) > 0.001) {
      target.volume = session.volume;
    }

    if (target.muted !== session.muted) {
      target.muted = session.muted;
    }

    if (Math.abs(target.playbackRate - session.playbackRate) > 0.001) {
      target.playbackRate = session.playbackRate;
      target.defaultPlaybackRate = session.playbackRate;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearFrameHoldTimer();
      clearStallTimer();
      releaseMirrorStream();
    };
  }, [clearFrameHoldTimer, clearStallTimer, releaseMirrorStream]);

  useEffect(() => {
    return () => {
      emitPlaybackState(false, videoRef.current);
    };
  }, [emitPlaybackState]);

  useEffect(() => {
    lastSyncStateRef.current = {
      currentTimeMs: Math.max(0, resumeRef.current.resumeFromMs ?? 0),
      isPlaying: Boolean(resumeRef.current.autoPlayOnLoad),
      volume: sessionRef.current.volume,
      muted: sessionRef.current.muted,
      playbackRate: sessionRef.current.playbackRate,
    };
    setHasError(false);
    setStallError(false);
    setCurrentTime(0);
    setDuration(0);
    hasProgressRef.current = false;
    hasSeenLoadRef.current = false;
    playIntentRef.current = false;
    hasIssuedAutoplayRef.current = false;
    clearStallTimer();
    releaseMirrorStream();
    emitPlaybackState(false, null);
  }, [clearStallTimer, emitPlaybackState, mediaKey, releaseMirrorStream]);

  useLayoutEffect(() => {
    isTearingDownRef.current = false;

    return () => {
      updateLastSyncState(videoRef.current);
      isTearingDownRef.current = true;
    };
  }, [mediaKey, updateLastSyncState]);

  useEffect(() => {
    if (episodeDuration && episodeDuration > 0) {
      setDuration(episodeDuration);
      onDurationChange?.(episodeDuration);
    }
  }, [episodeDuration, onDurationChange]);

  useEffect(() => {
    applySessionSettings(videoRef.current);
  }, [applySessionSettings, sessionMuted, sessionPlaybackRate, sessionVolume]);

  useEffect(() => {
    if (videoRef.current) return;

    lastSyncStateRef.current = {
      ...lastSyncStateRef.current,
      volume: sessionRef.current.volume,
      muted: sessionRef.current.muted,
      playbackRate: sessionRef.current.playbackRate,
    };
  }, [sessionMuted, sessionPlaybackRate, sessionVolume]);

  const togglePlay = useCallback(() => {
    const mediaEl = videoRef.current;
    if (!mediaEl) return;

    if (mediaEl.paused) {
      playIntentRef.current = true;
      mediaEl.play().catch(() => {
        playIntentRef.current = false;
        emitPlaybackState(true, mediaEl);
      });
      emitPlaybackState(true, mediaEl);
      return;
    }

    playIntentRef.current = false;
    mediaEl.pause();
  }, [emitPlaybackState]);

  const stepFrame = useCallback((direction: 1 | -1, frameCount = 1) => {
    const mediaEl = videoRef.current;
    if (!mediaEl) return;
    mediaEl.pause();
    const minFile = startOffset / 1000;
    const maxFile = episodeDuration ? (startOffset + episodeDuration) / 1000 : (mediaEl.duration || 0);
    mediaEl.currentTime = Math.max(minFile, Math.min(
      (mediaEl.currentTime ?? 0) + (direction * frameCount * frameStepMs / 1000),
      maxFile,
    ));
  }, [startOffset, episodeDuration, frameStepMs]);

  const beginFrameHold = useCallback((source: FrameHoldSource, direction: 1 | -1) => {
    frameHoldHasRepeatedRef.current = false;
    clearFrameHoldTimer();
    frameHoldSourceRef.current = source;
    frameHoldDirectionRef.current = direction;

    const scheduleRepeat = () => {
      frameHoldTimerRef.current = setTimeout(() => {
        const now = performance.now();
        const holdStartAt = frameHoldStartAtRef.current ?? now;
        const lastTickAt = frameHoldLastTickAtRef.current ?? now;
        const holdElapsedMs = now - holdStartAt;
        const deltaMs = now - lastTickAt;
        const rampProgress = Math.min(1, holdElapsedMs / FRAME_HOLD_ACCELERATION_DURATION_MS);
        const speedMultiplier = FRAME_HOLD_START_SPEED_MULTIPLIER
          + ((FRAME_HOLD_MAX_SPEED_MULTIPLIER - FRAME_HOLD_START_SPEED_MULTIPLIER) * rampProgress);

        frameHoldLastTickAtRef.current = now;
        frameHoldCarryMsRef.current += deltaMs * speedMultiplier;

        const framesToStep = Math.floor(frameHoldCarryMsRef.current / frameStepMs);
        if (framesToStep > 0) {
          frameHoldHasRepeatedRef.current = true;
          frameHoldCarryMsRef.current -= framesToStep * frameStepMs;
          stepFrame(direction, framesToStep);
        }

        scheduleRepeat();
      }, FRAME_HOLD_TICK_MS);
    };

    frameHoldTimerRef.current = setTimeout(() => {
      const now = performance.now();
      frameHoldStartAtRef.current = now;
      frameHoldLastTickAtRef.current = now;
      frameHoldCarryMsRef.current = 0;
      frameHoldHasRepeatedRef.current = true;
      stepFrame(direction);
      scheduleRepeat();
    }, FRAME_HOLD_INITIAL_DELAY_MS);
  }, [clearFrameHoldTimer, stepFrame, frameStepMs]);

  const startFrameHold = useCallback((direction: 1 | -1, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    suppressFrameClickRef.current = null;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    beginFrameHold(direction === -1 ? 'button-prev' : 'button-next', direction);
  }, [beginFrameHold]);

  const stopFrameHold = useCallback((direction: 1 | -1) => {
    const source: FrameHoldSource = direction === -1 ? 'button-prev' : 'button-next';
    if (frameHoldSourceRef.current !== source) return;
    const heldDirection = frameHoldDirectionRef.current;
    const didRepeat = frameHoldHasRepeatedRef.current;
    clearFrameHoldTimer();
    if (didRepeat && heldDirection !== null) {
      suppressFrameClickRef.current = heldDirection;
    }
    frameHoldHasRepeatedRef.current = false;
  }, [clearFrameHoldTimer]);

  const startFrameKeyHold = useCallback((direction: 1 | -1) => {
    const source: FrameHoldSource = direction === -1 ? 'key-prev' : 'key-next';
    beginFrameHold(source, direction);
    stepFrame(direction);
  }, [beginFrameHold, stepFrame]);

  const stopFrameKeyHold = useCallback((direction: 1 | -1) => {
    const source: FrameHoldSource = direction === -1 ? 'key-prev' : 'key-next';
    if (frameHoldSourceRef.current !== source) return;
    clearFrameHoldTimer();
    frameHoldHasRepeatedRef.current = false;
  }, [clearFrameHoldTimer]);

  const handleFrameStepClick = useCallback((direction: 1 | -1) => {
    if (suppressFrameClickRef.current === direction) {
      suppressFrameClickRef.current = null;
      return;
    }
    stepFrame(direction);
  }, [stepFrame]);

  const seek = useCallback((offsetMs: number) => {
    const mediaEl = videoRef.current;
    if (!mediaEl) return;
    const minFile = startOffset / 1000;
    const maxFile = episodeDuration ? (startOffset + episodeDuration) / 1000 : (mediaEl.duration || 0);
    mediaEl.currentTime = Math.max(minFile, Math.min(
      (mediaEl.currentTime ?? 0) + offsetMs / 1000,
      maxFile,
    ));
  }, [startOffset, episodeDuration]);

  const scrubSeek = useCallback((ratio: number) => {
    const mediaEl = videoRef.current;
    if (!mediaEl) return;
    const epMs = ratio * duration;
    mediaEl.currentTime = (epMs + startOffset) / 1000;
  }, [duration, startOffset]);

  const captureTime = useCallback(() => {
    return Math.round((videoRef.current?.currentTime ?? 0) * 1000 - startOffset);
  }, [startOffset]);

  const seekTo = useCallback((ms: number) => {
    const mediaEl = videoRef.current;
    if (!mediaEl) return;
    const minFile = startOffset / 1000;
    const maxFile = episodeDuration ? (startOffset + episodeDuration) / 1000 : (mediaEl.duration || 0);
    mediaEl.currentTime = Math.max(minFile, Math.min((ms + startOffset) / 1000, maxFile));
  }, [episodeDuration, startOffset]);

  const getCurrentTime = useCallback(() => {
    return (videoRef.current?.currentTime ?? 0) * 1000 - startOffset;
  }, [startOffset]);

  const getSyncState = useCallback((): PlaybackSyncState => {
    if (isTearingDownRef.current) {
      return lastSyncStateRef.current;
    }

    return updateLastSyncState(videoRef.current);
  }, [updateLastSyncState]);

  const getMirrorStream = useCallback((): MediaStream | null => {
    const existingStream = mirrorStreamRef.current;
    if (existingStream) {
      const hasLiveTrack = existingStream.getVideoTracks().some(track => track.readyState === 'live');
      if (hasLiveTrack) {
        return existingStream;
      }

      releaseMirrorStream();
    }

    const mediaEl = videoRef.current as CaptureStreamCapableVideoElement | null;
    if (!mediaEl) {
      return null;
    }

    try {
      const sourceStream = mediaEl.captureStream?.() ?? mediaEl.mozCaptureStream?.();
      const videoTracks = sourceStream?.getVideoTracks() ?? [];

      if (!videoTracks.length) {
        return null;
      }

      mirrorStreamRef.current = new MediaStream(videoTracks.map(track => track.clone()));
      return mirrorStreamRef.current;
    } catch (error) {
      console.warn('[VideoPlayer] mirror stream capture failed', {
        error: String(error),
        src: mediaEl.currentSrc || mediaEl.src,
      });
      return null;
    }
  }, [releaseMirrorStream]);

  const stop = useCallback(() => {
    const mediaEl = videoRef.current;
    if (!mediaEl) return;

    playIntentRef.current = false;
    clearStallTimer();
    mediaEl.pause();
    mediaEl.currentTime = startOffset / 1000;
    setCurrentTime(0);
    latestRef.current.onTimeUpdate?.(0);
    emitPlaybackState(true, mediaEl);
  }, [clearStallTimer, emitPlaybackState, startOffset]);

  useImperativeHandle(ref, () => ({
    seekTo,
    getCurrentTime,
    togglePlay,
    seekBy: seek,
    stop,
    getSyncState,
    getMirrorStream,
  }), [getCurrentTime, getMirrorStream, getSyncState, seek, seekTo, stop, togglePlay]);

  const handleSkipMarker = useCallback((marker: Marker) => {
    const mediaEl = videoRef.current;
    if (!mediaEl) return;
    const minFile = startOffset / 1000;
    const maxEpisodeMs = episodeDuration ?? Number.POSITIVE_INFINITY;
    const targetMs = Math.min(marker.end + SKIP_MARKER_EPSILON_MS, maxEpisodeMs);
    const maxFile = episodeDuration ? (startOffset + episodeDuration) / 1000 : (mediaEl.duration || 0);
    mediaEl.currentTime = Math.max(minFile, Math.min((targetMs + startOffset) / 1000, maxFile));
  }, [episodeDuration, startOffset]);

  const handleTimeUpdate = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaEl = e.currentTarget;
    hasProgressRef.current = true;
    clearStallTimer();
    const { startOffset: off, onTimeUpdate: cb } = latestRef.current;
    const epMs = (mediaEl.currentTime ?? 0) * 1000 - off;
    setCurrentTime(epMs);
    updateLastSyncState(mediaEl);
    cb?.(epMs);
  }, [clearStallTimer, updateLastSyncState]);

  const handleDurationChange = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaEl = e.currentTarget;
    const { startOffset: off, episodeDuration: epDur, onDurationChange: cb } = latestRef.current;
    const fileMs = (mediaEl.duration ?? 0) * 1000;
    const knownFileMs = Number.isFinite(fileMs) ? fileMs : 0;
    const episodePortionMs = knownFileMs > 0 ? knownFileMs - off : 0;
    const epMs = Math.max(epDur ?? 0, episodePortionMs);
    if (epMs > 0) {
      setDuration(epMs);
      cb?.(epMs);
    }
  }, []);

  const handleLoadedMetadata = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaEl = e.currentTarget;
    const { startOffset: off } = latestRef.current;
    applySessionSettings(mediaEl);
    if (!hasSeenLoadRef.current) {
      hasSeenLoadRef.current = true;
      const resumeMs = Math.max(0, resumeRef.current.resumeFromMs ?? 0);
      const targetMs = off + resumeMs;
      if (targetMs > 0) {
        mediaEl.currentTime = targetMs / 1000;
      }
    }
    emitPlaybackState(true, mediaEl);
  }, [emitPlaybackState]);

  const requestAutoplay = useCallback((mediaEl: HTMLVideoElement) => {
    if (!resumeRef.current.autoPlayOnLoad || hasIssuedAutoplayRef.current) {
      return;
    }

    hasIssuedAutoplayRef.current = true;
    playIntentRef.current = true;
    mediaEl.play().catch(error => {
      const shouldRetryMuted = !mediaEl.muted;

      if (shouldRetryMuted) {
        const originalMuted = mediaEl.muted;
        mediaEl.muted = true;

        mediaEl.play()
          .then(() => {
            mediaEl.muted = originalMuted;
            emitPlaybackState(true, mediaEl);
          })
          .catch(retryError => {
            mediaEl.muted = originalMuted;
            playIntentRef.current = false;
            emitPlaybackState(true, mediaEl);
            console.warn('[VideoPlayer] fallback autoplay failed', {
              error: String(retryError),
              src: mediaEl.currentSrc || mediaEl.src,
            });
          });
        return;
      }

      playIntentRef.current = false;
      emitPlaybackState(true, mediaEl);
      console.warn('[VideoPlayer] fallback autoplay failed', {
        error: String(error),
        src: mediaEl.currentSrc || mediaEl.src,
      });
    });
  }, [emitPlaybackState]);

  const handleCanPlay = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    applySessionSettings(e.currentTarget);
    requestAutoplay(e.currentTarget);
    emitPlaybackState(true, e.currentTarget);
  }, [applySessionSettings, emitPlaybackState, requestAutoplay]);

  const handleWaiting = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaEl = e.currentTarget;
    if (stallTimerRef.current || !playIntentRef.current || mediaEl.ended) return;

    stallTimerRef.current = setTimeout(() => {
      if (!hasProgressRef.current && playIntentRef.current && !mediaEl.ended) {
        console.warn('[VideoPlayer] stall: no progress in 20s', { src: mediaEl.currentSrc || mediaEl.src });
        setStallError(true);
        emitPlaybackState(false, mediaEl);
        onPlaybackFailedRef.current?.({
          attemptedToPlay: true,
          currentTimeMs: Math.max(0, captureTime()),
        });
      }
    }, STALL_TIMEOUT_MS);
  }, [captureTime, emitPlaybackState]);

  const handleError = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaEl = e.currentTarget;
    const err = mediaEl.error;
    const CODES: Record<number, string> = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    const attemptedToPlay = playIntentRef.current;
    const currentTimeMs = Math.max(0, captureTime());
    console.warn('[VideoPlayer] error', {
      code: err?.code,
      type: err?.code ? CODES[err.code] : 'unknown',
      message: err?.message,
      src: mediaEl.currentSrc || mediaEl.src,
      attemptedToPlay,
      currentTimeMs,
    });
    if (err && err.code !== 1) {
      setHasError(true);
      emitPlaybackState(false, mediaEl);
      if (attemptedToPlay) {
        onPlaybackFailedRef.current?.({ attemptedToPlay, currentTimeMs });
      }
    }
  }, [captureTime, emitPlaybackState]);

  const handlePlay = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    isTearingDownRef.current = false;
    playIntentRef.current = true;
    clearStallTimer();
    requestAutoplay(e.currentTarget);
    emitPlaybackState(true, e.currentTarget);
  }, [clearStallTimer, emitPlaybackState, requestAutoplay]);

  const handlePause = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    if (isTearingDownRef.current) {
      clearStallTimer();
      return;
    }

    if (!e.currentTarget.ended) {
      playIntentRef.current = false;
    }
    clearStallTimer();
    emitPlaybackState(true, e.currentTarget);
  }, [clearStallTimer, emitPlaybackState]);

  const handleEnded = useCallback(() => {
    playIntentRef.current = false;
    clearStallTimer();
    emitPlaybackState(true, videoRef.current);
  }, [clearStallTimer, emitPlaybackState]);

  const handleVolumeChange = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    emitPlaybackState(true, e.currentTarget);
  }, [emitPlaybackState]);

  const handleRateChange = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    emitPlaybackState(true, e.currentTarget);
  }, [emitPlaybackState]);

  const mediaElementProps = useMemo<PlayerMediaElementProps>(() => ({
    className: mediaClassName,
    playsInline: true,
    preload: 'auto',
    crossOrigin: 'anonymous',
    onPlay: handlePlay,
    onPause: handlePause,
    onEnded: handleEnded,
    onTimeUpdate: handleTimeUpdate,
    onDurationChange: handleDurationChange,
    onLoadedMetadata: handleLoadedMetadata,
    onCanPlay: handleCanPlay,
    onVolumeChange: handleVolumeChange,
    onRateChange: handleRateChange,
    onWaiting: handleWaiting,
    onStalled: handleWaiting,
    onError: handleError,
  }), [
    handleCanPlay,
    handleDurationChange,
    handleEnded,
    handleError,
    handleLoadedMetadata,
    handlePause,
    handlePlay,
    handleRateChange,
    handleTimeUpdate,
    handleVolumeChange,
    handleWaiting,
    mediaClassName,
  ]);

  useEffect(() => {
    if (!enableGlobalHotkeys) {
      return undefined;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); seek(e.shiftKey ? -1000 : -5000); break;
        case 'ArrowRight': e.preventDefault(); seek(e.shiftKey ? 1000 : 5000); break;
        case ',':
          e.preventDefault();
          if (!e.repeat && frameHoldSourceRef.current !== 'key-prev') {
            startFrameKeyHold(-1);
          }
          break;
        case '.':
          e.preventDefault();
          if (!e.repeat && frameHoldSourceRef.current !== 'key-next') {
            startFrameKeyHold(1);
          }
          break;
        case 'm':
          if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
          break;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      switch (e.key) {
        case ',': stopFrameKeyHold(-1); break;
        case '.': stopFrameKeyHold(1); break;
      }
    };
    const handleBlur = () => {
      clearFrameHoldTimer();
      frameHoldHasRepeatedRef.current = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [togglePlay, seek, startFrameKeyHold, stopFrameKeyHold, clearFrameHoldTimer, enableGlobalHotkeys]);

  // Error display — only when no fallback is available (onPlaybackFailed absent)
  if ((hasError || stallError || codecWarning) && !onPlaybackFailed) {
    const message = codecWarning
      || (stallError
        ? 'Video did not start within 20 seconds. Your Plex server may be unable to stream this file — check the Plex dashboard for errors.'
        : 'Video failed to load. Ensure your Plex URL and token are correct and the server is reachable.');
    return (
      <div className="relative w-full aspect-video plex-editor-section flex items-center justify-center">
        <div className="text-center px-4 md:px-8 max-w-md">
          <div className="text-3xl mb-3 opacity-40">&#9888;</div>
          <p className="text-sm text-[var(--color-text-default)] font-medium mb-1">Video cannot be played</p>
          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{message}</p>
        </div>
      </div>
    );
  }

  if (layout === 'surface') {
    return (
      <div className="w-full h-full select-none">
        <div className={`relative w-full h-full overflow-hidden bg-transparent ${surfaceClassName}`.trim()}>
          <PlayerSurface
            videoRef={videoRef}
            mediaKey={mediaKey}
            src={src}
            sourceType={sourceType}
            isHlsSource={isHlsSource}
            supportsNativeHls={supportsNativeHls}
            mediaElementProps={mediaElementProps}
            withSkin={false}
          />

          {showMarkerOverlay && <MarkerOverlay currentTime={currentTime} markers={markers} onSkip={handleSkipMarker} />}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full select-none">
      <div className="relative w-full aspect-video rounded-t-[20px] overflow-hidden bg-transparent group">
        <PlayerSurface
          videoRef={videoRef}
          mediaKey={mediaKey}
          src={src}
          sourceType={sourceType}
          isHlsSource={isHlsSource}
          supportsNativeHls={supportsNativeHls}
          mediaElementProps={mediaElementProps}
          withSkin
        />

        {showMarkerOverlay && <MarkerOverlay currentTime={currentTime} markers={markers} onSkip={handleSkipMarker} />}
      </div>

      <div className="mt-4 md:mt-2 plex-editor-section rounded-t-none px-2 md:px-3 py-2 md:py-2.5">
        {/* Inline scrub bar */}
        <div
          ref={scrubRef}
          className="relative h-7 md:h-5 mb-2 group/scrub cursor-pointer touch-none"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).dataset.boundaryHandle) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            scrubSeek(ratio);
            const target = e.currentTarget;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            const onMove = (ev: PointerEvent) => {
              const r = target.getBoundingClientRect();
              const rat = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
              if (scrubBoundaryDrag !== null) {
                onBoundaryDrag?.(scrubBoundaryDrag, rat * duration);
              } else {
                scrubSeek(rat);
              }
            };
            const onUp = () => { setScrubBoundaryDrag(null); target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', onUp); };
            target.addEventListener('pointermove', onMove);
            target.addEventListener('pointerup', onUp);
          }}
        >
          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 md:h-1 group-hover/scrub:h-2 md:group-hover/scrub:h-1.5 bg-white/10 rounded-full overflow-hidden transition-all">
            <div className="absolute inset-y-0 left-0 bg-white/30 rounded-full" style={{ width: `${duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0}%` }} />
          </div>

          {markers.map(marker => {
            const left = duration > 0 ? Math.min((marker.start / duration) * 100, 100) : 0;
            const endPct = duration > 0 ? Math.min((marker.end / duration) * 100, 100) : 0;
            const width = Math.max(endPct - left, 0);
            const markerColor = marker.type === 'intro' ? overlayColors.intro
              : marker.type === 'credits' ? overlayColors.credits
              : marker.type === 'commercial' ? overlayColors.commercial
              : 'rgb(161 161 170)';
            return (
              <div key={marker.id} className="absolute top-1/2 -translate-y-1/2 h-3 md:h-2 group-hover/scrub:h-3.5 md:group-hover/scrub:h-2.5 rounded-sm transition-all pointer-events-none"
                style={{ left: `${left}%`, width: `${Math.max(width, 0.3)}%`, background: markerColor, opacity: 0.5 }}
                title={`${marker.type}: ${formatTimecode(marker.start)} – ${formatTimecode(marker.end)}`}
              />
            );
          })}

          {episodeBoundaries?.map((boundary, i) => {
            const pct = duration > 0 ? (boundary.position / duration) * 100 : 0;
            return (
              <div key={`scrub-boundary-${i}`} data-boundary-handle="true"
                className={`absolute top-0 bottom-0 cursor-col-resize z-10 ${scrubBoundaryDrag === i ? 'w-4 -ml-2' : 'w-3 -ml-1.5 hover:w-4 hover:-ml-2'}`}
                style={{ left: `${pct}%` }}
                title={boundary.label}
                onPointerDown={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  setScrubBoundaryDrag(i);
                  scrubRef.current?.setPointerCapture(e.pointerId);
                  const onMove = (ev: PointerEvent) => {
                    if (!scrubRef.current) return;
                    const r = scrubRef.current.getBoundingClientRect();
                    onBoundaryDrag?.(i, Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * duration);
                  };
                  const onUp = () => { setScrubBoundaryDrag(null); scrubRef.current?.removeEventListener('pointermove', onMove); scrubRef.current?.removeEventListener('pointerup', onUp); };
                  scrubRef.current?.addEventListener('pointermove', onMove);
                  scrubRef.current?.addEventListener('pointerup', onUp);
                }}
              >
                <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-[9px] font-medium whitespace-nowrap pointer-events-none select-none" style={{ color: overlayColors.episodeBoundary }}>
                  {boundary.label}
                </div>
                <div className="mx-auto w-px h-full" style={{ background: overlayColors.episodeBoundary }} />
              </div>
            );
          })}

          {/* Chapter boundaries */}
          {chapters.length > 0 && chapters.map((chapter, i) => {
            if (i === 0) return null;
            const pct = duration > 0 ? (chapter.start / duration) * 100 : 0;
            return (
              <div
                key={`scrub-chapter-${i}`}
                className="absolute top-1/2 -translate-y-1/2 w-px h-3 pointer-events-none z-[5]"
                style={{ left: `${pct}%`, background: overlayColors.chapterBoundary, opacity: 0.4 }}
                title={chapter.name || `Chapter ${i + 1}`}
              />
            );
          })}

          <div className="absolute top-1/2 w-3.5 h-3.5 md:w-2.5 md:h-2.5 bg-white rounded-full shadow-sm transition-all pointer-events-none"
            style={{ left: `${duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0}%`, transform: 'translate(-50%, -50%)' }}
          />
        </div>

        {/* Marker-editing toolbar — frame step, precision timecode, Set Start/End */}
        <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
          <div className="flex min-w-0 items-center gap-1.5 md:gap-2">
            <button
              onPointerDown={(e) => startFrameHold(-1, e)}
              onPointerUp={() => stopFrameHold(-1)}
              onPointerCancel={() => stopFrameHold(-1)}
              onLostPointerCapture={() => stopFrameHold(-1)}
              onClick={() => handleFrameStepClick(-1)}
              className="ctrl-btn text-[11px] px-2 md:px-1.5"
              title="Previous frame (,)"
            >
              &#9666;
            </button>
            <button
              onPointerDown={(e) => startFrameHold(1, e)}
              onPointerUp={() => stopFrameHold(1)}
              onPointerCancel={() => stopFrameHold(1)}
              onLostPointerCapture={() => stopFrameHold(1)}
              onClick={() => handleFrameStepClick(1)}
              className="ctrl-btn text-[11px] px-2 md:px-1.5"
              title="Next frame (.)"
            >
              &#9656;
            </button>
            <div className="timecode timecode-highlight text-[11px] md:text-xs tracking-wider">{formatTimecode(currentTime)}</div>
            <span className="text-[var(--color-text-faint)] text-[11px]">/</span>
            <div className="timecode text-[11px] text-[var(--color-text-muted)]">{formatTimecode(duration)}</div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 md:gap-2">
            <button onClick={() => onSetStart?.(captureTime())} className="ctrl-btn ctrl-btn-accent text-[11px] gap-1" title="Set marker start to current time">
              <span className="opacity-60">[</span> <span className="hidden sm:inline">Set </span>Start
            </button>
            <button onClick={() => onSetEnd?.(captureTime())} className="ctrl-btn ctrl-btn-accent text-[11px] gap-1" title="Set marker end to current time">
              <span className="hidden sm:inline">Set </span>End <span className="opacity-60">]</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

function formatTimecode(ms: number): string {
  if (!ms || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
