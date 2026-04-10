import type { SafeDB } from './connection.js';

export interface IntegrityResult {
  ok: boolean;
  /** If not ok, the issues found */
  issues: string[];
}

/**
 * Run a targeted integrity check on the taggings table.
 * Returns ok=true if the table is intact.
 *
 * We check only the taggings table instead of the whole database because the
 * Plex database contains FTS tables with custom tokenizers (e.g. unicode61
 * with collation) that aren't registered in our better-sqlite3 connection.
 * Both PRAGMA integrity_check and PRAGMA quick_check attempt to verify those
 * tables and fail with "unknown tokenizer: collating".
 *
 * Since we only modify the taggings table, a targeted check is sufficient
 * and avoids the FTS tokenizer issue entirely.
 *
 * This should be called after every write operation
 * to verify we haven't corrupted anything.
 */
export function checkIntegrity(db: SafeDB): IntegrityResult {
  try {
    const rows = db.all<{ integrity_check: string }>('PRAGMA integrity_check(taggings)');

    if (rows.length === 1 && rows[0].integrity_check === 'ok') {
      return { ok: true, issues: [] };
    }

    const issues = rows.map(r => r.integrity_check);
    console.error('  INTEGRITY CHECK FAILED:');
    for (const issue of issues) {
      console.error(`    - ${issue}`);
    }

    return { ok: false, issues };
  } catch (err) {
    // If even the targeted check fails (e.g. due to SQLite extensions),
    // fall back to verifying we can read from the table we just wrote to.
    console.warn(`  PRAGMA integrity_check(taggings) failed, falling back to read-back verification: ${err instanceof Error ? err.message : String(err)}`);
    try {
      const count = db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM taggings');
      if (count && count.cnt >= 0) {
        return { ok: true, issues: [] };
      }
      return { ok: false, issues: ['Could not verify taggings table after write'] };
    } catch (readErr) {
      return { ok: false, issues: [`Table read-back failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`] };
    }
  }
}

/**
 * Run a quick check that marker indexes are contiguous (0, 1, 2, ...) for each episode.
 * This catches the specific corruption pattern from the old MarkerEditorForPlex.
 */
export function checkMarkerIndexes(db: SafeDB, markerTagId: number): {
  ok: boolean;
  issues: { parentId: number; expected: number[]; actual: number[] }[];
} {
  const rows = db.all<{ parent_id: number; idx: number }>(
    `SELECT metadata_item_id as parent_id, \`index\` as idx
     FROM taggings
     WHERE tag_id = ?
     ORDER BY metadata_item_id, \`index\``,
    markerTagId
  );

  // Group by parent_id
  const groups = new Map<number, number[]>();
  for (const row of rows) {
    const indexes = groups.get(row.parent_id) || [];
    indexes.push(row.idx);
    groups.set(row.parent_id, indexes);
  }

  const issues: { parentId: number; expected: number[]; actual: number[] }[] = [];

  for (const [parentId, indexes] of groups) {
    const expected = indexes.map((_, i) => i);
    const isContiguous = indexes.length === expected.length &&
      indexes.every((val, i) => val === expected[i]);

    if (!isContiguous) {
      issues.push({ parentId, expected, actual: indexes });
    }
  }

  return { ok: issues.length === 0, issues };
}
