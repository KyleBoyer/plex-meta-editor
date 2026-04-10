import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { api, type ArtworkKind } from '../../api/client';

interface ArtworkImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  metadataId?: number | null;
  metadataIds?: Array<number | null | undefined>;
  kind?: ArtworkKind;
  fallback?: ReactNode;
}

export function ArtworkImage({
  metadataId,
  metadataIds,
  kind = 'thumb',
  fallback = null,
  onError,
  ...imgProps
}: ArtworkImageProps) {
  const candidateIds = Array.from(
    new Set(
      [...(metadataIds ?? []), metadataId].filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
      ),
    ),
  );
  const candidateKey = candidateIds.join(',');
  const [failedIndex, setFailedIndex] = useState(0);
  const activeMetadataId = candidateIds[failedIndex] ?? null;

  useEffect(() => {
    setFailedIndex(0);
  }, [candidateKey, kind]);

  if (!activeMetadataId) {
    return <>{fallback}</>;
  }

  return (
    <img
      {...imgProps}
      src={api.getArtworkUrl(activeMetadataId, kind)}
      onError={event => {
        setFailedIndex(current => Math.min(current + 1, candidateIds.length));
        onError?.(event);
      }}
    />
  );
}
