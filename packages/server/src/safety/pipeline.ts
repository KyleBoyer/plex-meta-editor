/**
 * THE SAFETY PIPELINE
 *
 * This is the core safety mechanism. ALL writes go through this pipeline,
 * whether it's a single marker edit or a bulk operation of 1000 markers.
 *
 * Steps:
 *   1. Take fresh snapshot of current DB state
 *   2. Compare with last-known snapshot → detect Plex changes
 *   3. If conflicts exist → return them to caller (don't write)
 *   4. Create timestamped backup of the DB file
 *   5. Open DB in read-write mode with safety PRAGMAs
 *   6. Execute ALL statements in a SINGLE transaction (BEGIN IMMEDIATE → COMMIT)
 *   7. Run PRAGMA quick_check
 *   8. If integrity fails → restore from backup
 *   9. Close read-write connection
 *  10. Update last-known snapshot
 */

import { v4 as uuidv4 } from 'uuid';
import type { DbCheckResult, DbSnapshot, PipelineResult, WriteHistoryEntry } from '@plex-meta-editor/shared';
import type { AppConfig } from '../config.js';
import { SafeDB } from '../db/connection.js';
import { PlexSqliteService, PlexSqliteUnavailableError } from '../db/plex-sqlite.js';
import { takeSnapshot, hasDbFileChanged } from '../db/snapshot.js';
import { createBackup, restoreBackup, pruneBackups } from '../db/backup.js';
import { checkMarkerIndexes } from '../db/integrity.js';
import { detectConflicts } from './conflict.js';
import { getMarkerTagId } from '../plex/schema.js';
import type { SqlStatement } from '../plex/mutations.js';

/** State tracked across the lifetime of the server */
export class SafetyPipelineState {
  /** Last-known snapshot of the DB's marker state */
  lastSnapshot: DbSnapshot | null = null;
  /** History of write operations */
  writeHistory: WriteHistoryEntry[] = [];
  /** The marker tag ID (cached) */
  markerTagId: number | null = null;
  /** Latest full-database integrity check result */
  lastIntegrityCheck: DbCheckResult | null = null;

  private config: AppConfig;
  private plexSqlite: PlexSqliteService;

  constructor(config: AppConfig, plexSqlite: PlexSqliteService) {
    this.config = config;
    this.plexSqlite = plexSqlite;
  }

  /** Initialize by taking the first snapshot */
  initialize(db: SafeDB): void {
    this.markerTagId = getMarkerTagId(db);
    if (this.markerTagId !== null) {
      this.lastSnapshot = takeSnapshot(db, this.markerTagId);
      console.log(`  Snapshot taken: ${this.lastSnapshot.markerCount} markers`);
    } else {
      console.log(`  No markers found in database (tag_type=12 not present)`);
    }
  }

  /**
   * Execute the safety pipeline.
   *
   * @param readDb - The read-only DB connection (for snapshot comparison)
   * @param statements - SQL statements to execute (from mutation builders)
   * @param operation - Description of the operation (for history)
   * @param description - Human-readable description
   * @returns PipelineResult
   */
  async execute(
    readDb: SafeDB,
    statements: SqlStatement[],
    operation: WriteHistoryEntry['operation'],
    description: string,
  ): Promise<PipelineResult> {
    const writeUnavailableReason = this.plexSqlite.getUnavailableReason();
    if (writeUnavailableReason) {
      return {
        success: false,
        statusCode: 503,
        statementsExecuted: 0,
        markersAffected: 0,
        integrityOk: false,
        error: writeUnavailableReason,
      };
    }

    const historyId = uuidv4();

    console.log(`\n  Safety Pipeline: ${description}`);
    console.log(`    Statements: ${statements.length}`);

    // ── Step 1-2: Snapshot & Conflict Detection ───────────────────
    if (this.markerTagId !== null && this.lastSnapshot) {
      // Quick file check first
      if (hasDbFileChanged(this.lastSnapshot, this.config.dbPath)) {
        console.log(`    DB file changed since last snapshot, checking for conflicts...`);
        readDb.refreshReadOnly(this.config.busyTimeout);
        const freshSnapshot = takeSnapshot(readDb, this.markerTagId);

        if (freshSnapshot.markerHash !== this.lastSnapshot.markerHash) {
          const conflict = detectConflicts(readDb, this.lastSnapshot, this.markerTagId);
          if (conflict && conflict.hasConflicts) {
            console.log(`    CONFLICT DETECTED: ${conflict.ourChangesAffected.length} changes affected`);
            return {
              success: false,
              statementsExecuted: 0,
              markersAffected: 0,
              integrityOk: true,
              error: 'Conflict detected: Plex has modified the database since your last read',
              conflict,
            };
          }
          // Plex changed things, but no overlap with our changes — safe to continue
          console.log(`    Plex made changes but no conflicts with our edits`);
        }
      }
    }

    // ── Step 3: Create Backup ─────────────────────────────────────
    console.log(`    Creating backup...`);
    let backupPath: string;
    try {
      const backup = createBackup(this.config.dbPath, this.config.backupDir);
      backupPath = backup.backupPath;
    } catch (err) {
      const message = `Failed to create backup: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`    ${message}`);
      this.recordHistory(historyId, operation, description, 0, '', false);
      return {
        success: false,
        statementsExecuted: 0,
        markersAffected: 0,
        integrityOk: true,
        error: message,
      };
    }

    // ── Step 4: Open Read-Write & Execute ─────────────────────────
    try {
      console.log(`    Executing ${statements.length} statement(s) in transaction...`);
      await this.plexSqlite.executeTransaction(statements);
      console.log(`    Transaction committed successfully`);
    } catch (err) {
      const isUnavailable = err instanceof PlexSqliteUnavailableError;
      const message = `Transaction failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`    ${message}`);
      console.error(`    Rolling back is automatic (transaction failed). Backup at: ${backupPath}`);
      this.recordHistory(historyId, operation, description, 0, backupPath, false);
      return {
        success: false,
        statusCode: isUnavailable ? 503 : 500,
        backupPath,
        statementsExecuted: 0,
        markersAffected: 0,
        integrityOk: false,
        error: message,
      };
    }

    // ── Step 5: Integrity Check ───────────────────────────────────
    console.log(`    Running integrity check...`);
    const integrity = await this.runIntegrityCheck('write');

    if (!integrity.ok) {
      console.error(`    INTEGRITY CHECK FAILED! Restoring from backup...`);
      try {
        restoreBackup(backupPath, this.config.dbPath);
        readDb.refreshReadOnly(this.config.busyTimeout);
      } catch (restoreErr) {
        const restoreMessage = `Integrity check failed and restore also failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`;
        this.recordHistory(historyId, operation, description, 0, backupPath, false);
        return {
          success: false,
          statusCode: 500,
          backupPath,
          statementsExecuted: statements.length,
          markersAffected: 0,
          integrityOk: false,
          error: `${restoreMessage}. Integrity issues: ${integrity.issues.join('; ')}`,
        };
      }
      this.recordHistory(historyId, operation, description, 0, backupPath, false);
      return {
        success: false,
        statusCode: 500,
        backupPath,
        statementsExecuted: statements.length,
        markersAffected: 0,
        integrityOk: false,
        error: `Integrity check failed after write. Database restored from backup. Issues: ${integrity.issues.join('; ')}`,
      };
    }

    // Also check marker index contiguity
    readDb.refreshReadOnly(this.config.busyTimeout);
    console.log(`    Read connection refreshed`);

    if (this.markerTagId !== null) {
      const indexCheck = checkMarkerIndexes(readDb, this.markerTagId);
      if (!indexCheck.ok) {
        console.warn(`    WARNING: Marker index gaps detected in ${indexCheck.issues.length} episode(s)`);
        // This is a warning, not a failure — the write succeeded and integrity is OK
      }
    }

    // ── Step 6: Close & Update Snapshot ───────────────────────────
    // Update snapshot with the new state
    if (this.markerTagId !== null) {
      this.lastSnapshot = takeSnapshot(readDb, this.markerTagId);
    }

    // Prune old backups
    pruneBackups(this.config.backupDir, this.config.maxBackups);

    const markersAffected = statements.length; // approximate
    this.recordHistory(historyId, operation, description, markersAffected, backupPath, true);

    console.log(`    Pipeline complete: ${statements.length} statements, integrity OK`);

    return {
      success: true,
      backupPath,
      statementsExecuted: statements.length,
      markersAffected,
      integrityOk: true,
    };
  }

  async runManualIntegrityCheck(): Promise<DbCheckResult> {
    const reason = this.plexSqlite.getUnavailableReason();
    if (reason) {
      throw new PlexSqliteUnavailableError(reason);
    }

    return this.runIntegrityCheck('manual');
  }

  private async runIntegrityCheck(trigger: DbCheckResult['trigger']): Promise<DbCheckResult> {
    const result = await this.plexSqlite.runIntegrityCheck(trigger);
    this.lastIntegrityCheck = result;
    return result;
  }

  private recordHistory(
    id: string,
    operation: WriteHistoryEntry['operation'],
    description: string,
    markersAffected: number,
    backupPath: string,
    success: boolean,
  ): void {
    this.writeHistory.unshift({
      id,
      timestamp: Date.now(),
      operation,
      description,
      markersAffected,
      backupPath,
      success,
    });

    // Keep last 100 entries
    if (this.writeHistory.length > 100) {
      this.writeHistory = this.writeHistory.slice(0, 100);
    }
  }
}
