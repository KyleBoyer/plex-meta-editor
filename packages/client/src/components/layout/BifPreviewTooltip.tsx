import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../api/client';
import { BifParser } from '../../utils/bif';

function formatDuration(ms: number): string {
  if (!ms) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const MAX_CACHED_URLS = 50;

interface Props {
  metadataId: number;
  hoverRatio: number | null;
  duration: number;
  startOffset: number;
  trackRef: RefObject<HTMLDivElement | null>;
}

export function BifPreviewTooltip({ metadataId, hoverRatio, duration, startOffset, trackRef }: Props) {
  const parserRef = useRef<BifParser | null>(null);
  const parserMetadataIdRef = useRef<number | null>(null);
  const unavailableRef = useRef<Set<number>>(new Set());
  const urlCacheRef = useRef<Map<number, string>>(new Map());
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastFrameIndexRef = useRef<number>(-1);
  const hasEverHoveredRef = useRef(false);

  const revokeAllUrls = useCallback(() => {
    for (const url of urlCacheRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    urlCacheRef.current.clear();
  }, []);

  // Fetch BIF on first hover for a new metadataId
  useEffect(() => {
    if (hoverRatio === null) return;
    hasEverHoveredRef.current = true;

    if (parserMetadataIdRef.current === metadataId) return;
    if (unavailableRef.current.has(metadataId)) return;

    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    parserRef.current = null;
    parserMetadataIdRef.current = null;
    lastFrameIndexRef.current = -1;
    revokeAllUrls();
    setFrameUrl(null);

    api.fetchBif(metadataId, controller.signal)
      .then(buffer => {
        if (cancelled) return;
        if (!buffer) {
          unavailableRef.current.add(metadataId);
          setLoading(false);
          return;
        }
        try {
          parserRef.current = new BifParser(buffer);
          parserMetadataIdRef.current = metadataId;
        } catch {
          unavailableRef.current.add(metadataId);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          unavailableRef.current.add(metadataId);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [metadataId, hoverRatio, revokeAllUrls]);

  // Clean up URLs on unmount or metadataId change
  useEffect(() => {
    return () => {
      revokeAllUrls();
    };
  }, [metadataId, revokeAllUrls]);

  // Extract frame when hover position changes
  useEffect(() => {
    const parser = parserRef.current;
    if (!parser || hoverRatio === null || duration <= 0) {
      return;
    }

    const timeMs = hoverRatio * duration + startOffset;
    const frameIndex = parser.getFrameIndexAtTime(timeMs);

    if (frameIndex === lastFrameIndexRef.current) return;
    lastFrameIndexRef.current = frameIndex;

    // Check cache
    const cached = urlCacheRef.current.get(frameIndex);
    if (cached) {
      setFrameUrl(cached);
      return;
    }

    const blob = parser.getFrameAtTime(timeMs);
    if (!blob) {
      setFrameUrl(null);
      return;
    }

    // Evict oldest entries if cache is full
    const cache = urlCacheRef.current;
    if (cache.size >= MAX_CACHED_URLS) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        const oldUrl = cache.get(firstKey);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        cache.delete(firstKey);
      }
    }

    const url = URL.createObjectURL(blob);
    cache.set(frameIndex, url);
    setFrameUrl(url);
  }, [hoverRatio, duration, startOffset]);

  if (!frameUrl || hoverRatio === null || !hasEverHoveredRef.current || loading) {
    return null;
  }

  // Position the tooltip
  const track = trackRef.current;
  if (!track) return null;

  const trackRect = track.getBoundingClientRect();
  const tooltipWidth = 160;
  const halfTooltip = tooltipWidth / 2;
  const hoverPx = hoverRatio * trackRect.width;
  const clampedLeft = Math.max(halfTooltip, Math.min(trackRect.width - halfTooltip, hoverPx));
  const hoverTimeMs = hoverRatio * duration;

  return (
    <div
      className="plex-bif-tooltip"
      style={{ left: `${clampedLeft}px` }}
    >
      <img
        src={frameUrl}
        alt=""
        className="plex-bif-tooltip-image"
        draggable={false}
      />
      <div className="plex-bif-tooltip-time">
        {formatDuration(hoverTimeMs)}
      </div>
    </div>
  );
}
