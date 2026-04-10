import { MarkerType, type NewMarker, type UpdateMarker } from './types/plex.js';
import { MARKER_TYPES } from './constants.js';

export interface ValidationError {
  field: string;
  message: string;
}

/** Validate marker time bounds */
export function validateMarkerBounds(start: number, end: number): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Number.isFinite(start) || start < 0) {
    errors.push({ field: 'start', message: 'Start time must be a non-negative number' });
  }
  if (!Number.isFinite(end) || end <= 0) {
    errors.push({ field: 'end', message: 'End time must be a positive number' });
  }
  if (Number.isFinite(start) && Number.isFinite(end) && start >= end) {
    errors.push({ field: 'start', message: 'Start time must be less than end time' });
  }

  return errors;
}

/** Validate marker type */
export function validateMarkerType(type: string): ValidationError[] {
  if (!MARKER_TYPES.includes(type as MarkerType)) {
    return [{ field: 'type', message: `Invalid marker type "${type}". Must be one of: ${MARKER_TYPES.join(', ')}` }];
  }
  return [];
}

/** Validate that isFinal is only set for credits markers */
export function validateFinal(type: string, isFinal: boolean): ValidationError[] {
  if (isFinal && type !== MarkerType.Credits) {
    return [{ field: 'isFinal', message: 'Only credits markers can be marked as final' }];
  }
  return [];
}

/** Full validation for a new marker */
export function validateNewMarker(marker: NewMarker): ValidationError[] {
  return [
    ...validateMarkerBounds(marker.start, marker.end),
    ...validateMarkerType(marker.type),
    ...validateFinal(marker.type, marker.isFinal),
  ];
}

/** Full validation for a marker update */
export function validateUpdateMarker(marker: UpdateMarker): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Number.isFinite(marker.id) || marker.id <= 0) {
    errors.push({ field: 'id', message: 'Marker ID must be a positive integer' });
  }

  return [
    ...errors,
    ...validateMarkerBounds(marker.start, marker.end),
    ...validateMarkerType(marker.type),
    ...validateFinal(marker.type, marker.isFinal),
  ];
}
