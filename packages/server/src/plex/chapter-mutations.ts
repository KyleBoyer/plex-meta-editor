/**
 * Mutation builders for chapter data in the Plex database.
 *
 * Chapter writes modify media_parts.extra_data, which is a JSON blob.
 * We do a read-modify-write: parse the full JSON, update only pv:chapters,
 * then write the full JSON back — preserving all other keys.
 *
 * All mutations return SqlStatement[] for execution through the safety pipeline.
 */

import type { Chapter } from '@plex-meta-editor/shared';
import type { SqlStatement } from './mutations.js';
import { updateChaptersInExtraData } from './chapters.js';

/**
 * Build SQL statements to set (replace) all chapters for a media part.
 *
 * @param partId - The media_parts.id to update
 * @param chapters - The new chapter list
 * @param currentExtraData - The current extra_data string from the DB (must be read first)
 */
export function buildSetChaptersStatements(
  partId: number,
  chapters: Chapter[],
  currentExtraData: string,
): SqlStatement[] {
  const newExtraData = updateChaptersInExtraData(currentExtraData, chapters);

  return [{
    sql: 'UPDATE media_parts SET extra_data = ? WHERE id = ?',
    params: [newExtraData, partId],
  }];
}

/**
 * Build SQL statements to clear all chapters for a media part.
 * Sets pv:chapters to {"Chapters":{}} (empty), preserving all other keys.
 *
 * @param partId - The media_parts.id to update
 * @param currentExtraData - The current extra_data string from the DB (must be read first)
 */
export function buildClearChaptersStatements(
  partId: number,
  currentExtraData: string,
): SqlStatement[] {
  return buildSetChaptersStatements(partId, [], currentExtraData);
}
