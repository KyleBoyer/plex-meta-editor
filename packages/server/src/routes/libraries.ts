import { Router } from 'express';
import type { SafeDB } from '../db/connection.js';
import type { LibrarySearchResult } from '@plex-meta-editor/shared';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function getSearchRank(result: LibrarySearchResult, query: string): number {
  const normalizedQuery = query.toLowerCase();
  const candidates = [result.sortTitle, result.title, result.originalTitle].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (normalized.startsWith(normalizedQuery)) return 0;
  }

  for (const candidate of candidates) {
    if (candidate.toLowerCase().includes(normalizedQuery)) return 1;
  }

  return 2;
}

export function createLibraryRoutes(db: SafeDB): Router {
  const router = Router();

  // GET /api/libraries — list all Plex libraries
  router.get('/', (_req, res, next) => {
    try {
      const rows = db.all<{ id: number; name: string; section_type: number; uuid: string }>(
        'SELECT id, name, section_type, uuid FROM library_sections ORDER BY name'
      );

      const libraries = rows.map(row => ({
        id: row.id,
        name: row.name,
        type: row.section_type,
        uuid: row.uuid,
      }));

      res.json({ success: true, data: libraries });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/libraries/search?q=term[&libraryId=1] — cross-library title search
  router.get('/search', (req, res, next) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const libraryIdParam = typeof req.query.libraryId === 'string'
        ? Number.parseInt(req.query.libraryId, 10)
        : null;
      const libraryId = libraryIdParam && Number.isFinite(libraryIdParam) ? libraryIdParam : null;

      if (!query) {
        res.json({ success: true, data: [] });
        return;
      }

      const like = `%${escapeLikePattern(query)}%`;
      const baseParams = libraryId ? [libraryId, like, like, like] : [like, like, like];
      const libraryFilterSql = libraryId ? 'AND mi.library_section_id = ?' : '';

      const showRows = db.all<{
        id: number;
        title: string;
        title_sort: string;
        original_title: string;
        library_id: number;
        library_name: string;
        library_type: number;
        season_count: number;
        episode_count: number;
      }>(
        `SELECT mi.id, mi.title, mi.title_sort, mi.original_title,
                ls.id as library_id, ls.name as library_name, ls.section_type as library_type,
                (SELECT COUNT(*) FROM metadata_items s WHERE s.parent_id = mi.id AND s.metadata_type = 3) as season_count,
                (SELECT COUNT(*) FROM metadata_items e WHERE e.parent_id IN
                  (SELECT s2.id FROM metadata_items s2 WHERE s2.parent_id = mi.id AND s2.metadata_type = 3)
                  AND e.metadata_type = 4) as episode_count
         FROM metadata_items mi
         JOIN library_sections ls ON ls.id = mi.library_section_id
         WHERE mi.metadata_type = 2
           ${libraryFilterSql}
           AND (
             lower(COALESCE(mi.title, '')) LIKE lower(?) ESCAPE '\\'
             OR lower(COALESCE(mi.title_sort, '')) LIKE lower(?) ESCAPE '\\'
             OR lower(COALESCE(mi.original_title, '')) LIKE lower(?) ESCAPE '\\'
           )
         ORDER BY ls.name, COALESCE(mi.title_sort, mi.title)
         LIMIT 100`,
        ...baseParams,
      );

      const movieRows = db.all<{
        id: number;
        title: string;
        title_sort: string;
        original_title: string;
        year: number;
        edition_title: string;
        duration: number;
        file_duration: number;
        library_id: number;
        library_name: string;
        library_type: number;
      }>(
        `SELECT mi.id, mi.title, mi.title_sort, mi.original_title,
                mi.year, mi.edition_title, mi.duration,
                COALESCE((
                  SELECT MAX(mdi.duration)
                  FROM media_items mdi
                  WHERE mdi.metadata_item_id = mi.id
                ), 0) as file_duration,
                ls.id as library_id, ls.name as library_name, ls.section_type as library_type
         FROM metadata_items mi
         JOIN library_sections ls ON ls.id = mi.library_section_id
         WHERE mi.metadata_type = 1
           ${libraryFilterSql}
           AND (
             lower(COALESCE(mi.title, '')) LIKE lower(?) ESCAPE '\\'
             OR lower(COALESCE(mi.title_sort, '')) LIKE lower(?) ESCAPE '\\'
             OR lower(COALESCE(mi.original_title, '')) LIKE lower(?) ESCAPE '\\'
           )
         ORDER BY ls.name, COALESCE(mi.title_sort, mi.title)
         LIMIT 100`,
        ...baseParams,
      );

      const results: LibrarySearchResult[] = [
        ...showRows.map(row => ({
          id: row.id,
          kind: 'show' as const,
          title: row.title,
          sortTitle: row.title_sort || row.title,
          originalTitle: row.original_title || '',
          seasonCount: row.season_count,
          episodeCount: row.episode_count,
          libraryId: row.library_id,
          libraryName: row.library_name,
          libraryType: row.library_type,
        })),
        ...movieRows.map(row => ({
          id: row.id,
          kind: 'movie' as const,
          title: row.title,
          sortTitle: row.title_sort || row.title,
          originalTitle: row.original_title || '',
          year: row.year || 0,
          edition: row.edition_title || '',
          duration: row.duration || 0,
          fileDuration: row.file_duration,
          libraryId: row.library_id,
          libraryName: row.library_name,
          libraryType: row.library_type,
        })),
      ].sort((a, b) => {
        const rankDiff = getSearchRank(a, query) - getSearchRank(b, query);
        if (rankDiff !== 0) return rankDiff;

        const titleDiff = a.sortTitle.localeCompare(b.sortTitle);
        if (titleDiff !== 0) return titleDiff;

        return a.libraryName.localeCompare(b.libraryName);
      });

      res.json({ success: true, data: results });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/libraries/:id/shows — shows in a TV library
  router.get('/:id/shows', (req, res, next) => {
    try {
      const libraryId = parseInt(req.params.id, 10);
      const rows = db.all<{
        id: number; title: string; title_sort: string; original_title: string;
        season_count: number; episode_count: number;
        year: number; summary: string; content_rating: string; rating: number | null;
        tags_genre: string; studio: string;
      }>(
        `SELECT mi.id, mi.title, mi.title_sort, mi.original_title,
                mi.year, mi.summary, mi.content_rating, mi.rating, mi.tags_genre, mi.studio,
                (SELECT COUNT(*) FROM metadata_items s WHERE s.parent_id = mi.id AND s.metadata_type = 3) as season_count,
                (SELECT COUNT(*) FROM metadata_items e WHERE e.parent_id IN
                  (SELECT s2.id FROM metadata_items s2 WHERE s2.parent_id = mi.id AND s2.metadata_type = 3)
                  AND e.metadata_type = 4) as episode_count
         FROM metadata_items mi
         WHERE mi.library_section_id = ? AND mi.metadata_type = 2
         ORDER BY mi.title_sort`,
        libraryId
      );

      const shows = rows.map(row => ({
        id: row.id,
        title: row.title,
        sortTitle: row.title_sort || row.title,
        originalTitle: row.original_title || '',
        seasonCount: row.season_count,
        episodeCount: row.episode_count,
        year: row.year || 0,
        summary: row.summary || '',
        contentRating: row.content_rating || '',
        rating: row.rating ?? null,
        genres: row.tags_genre || '',
        studio: row.studio || '',
        libraryId,
      }));

      res.json({ success: true, data: shows });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/libraries/:id/movies — movies in a movie library
  router.get('/:id/movies', (req, res, next) => {
    try {
      const libraryId = parseInt(req.params.id, 10);
      const rows = db.all<{
        id: number; title: string; title_sort: string; original_title: string;
        year: number; edition_title: string; summary: string; content_rating: string; rating: number | null;
        duration: number; file_duration: number;
      }>(
        `SELECT mi.id, mi.title, mi.title_sort, mi.original_title,
                mi.year, mi.edition_title, mi.summary, mi.content_rating, mi.rating, mi.duration,
                COALESCE((
                  SELECT MAX(mdi.duration)
                  FROM media_items mdi
                  WHERE mdi.metadata_item_id = mi.id
                ), 0) as file_duration
         FROM metadata_items mi
         WHERE mi.library_section_id = ? AND mi.metadata_type = 1
         ORDER BY mi.title_sort`,
        libraryId
      );

      const movies = rows.map(row => ({
        id: row.id,
        title: row.title,
        sortTitle: row.title_sort || row.title,
        originalTitle: row.original_title || '',
        year: row.year || 0,
        edition: row.edition_title || '',
        summary: row.summary || '',
        contentRating: row.content_rating || '',
        rating: row.rating ?? null,
        duration: row.duration || 0,
        fileDuration: row.file_duration,
        libraryId,
      }));

      res.json({ success: true, data: movies });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
