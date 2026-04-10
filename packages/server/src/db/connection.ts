import Database from 'better-sqlite3';

/**
 * Safe wrapper around better-sqlite3 that enforces proper PRAGMAs
 * and provides read-only vs read-write modes.
 */
export class SafeDB {
  private db: Database.Database;
  readonly path: string;
  private _readOnly: boolean;

  private constructor(db: Database.Database, dbPath: string, readOnly: boolean) {
    this.db = db;
    this.path = dbPath;
    this._readOnly = readOnly;
  }

  /**
   * Open the database in read-only mode for browsing.
   * Sets WAL mode and busy timeout but prevents writes.
   */
  static openReadOnly(dbPath: string, busyTimeout: number = 5000): SafeDB {
    const db = new Database(dbPath, { readonly: true });
    db.pragma(`busy_timeout = ${busyTimeout}`);
    // WAL mode can only be set when opening read-write,
    // but if the DB is already in WAL mode, reads benefit from it.
    return new SafeDB(db, dbPath, true);
  }

  /**
   * Open the database in read-write mode for the safety pipeline.
   * Applies all safety PRAGMAs. Should be opened, used, and closed quickly.
   */
  static openReadWrite(dbPath: string, busyTimeout: number = 5000): SafeDB {
    const db = new Database(dbPath, { readonly: false });
    db.pragma(`busy_timeout = ${busyTimeout}`);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    return new SafeDB(db, dbPath, false);
  }

  /**
   * Reopen the current database path in read-only mode.
   * Used after external Plex SQLite writes so all future reads observe
   * the latest committed state through the shared wrapper instance.
   */
  refreshReadOnly(busyTimeout: number = 5000): void {
    if (this.db.open) {
      this.db.close();
    }

    const db = new Database(this.path, { readonly: true });
    db.pragma(`busy_timeout = ${busyTimeout}`);
    this.db = db;
    this._readOnly = true;
  }

  /** Run a query that returns no rows (INSERT, UPDATE, DELETE) */
  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(...params);
  }

  /** Get a single row */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Get all rows */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Prepare a statement for repeated execution */
  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  /**
   * Execute multiple statements as a single atomic transaction.
   * This is the core safety mechanism — all or nothing.
   */
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  /** Run a PRAGMA command and return the result */
  pragma(pragma: string): unknown {
    return this.db.pragma(pragma);
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  /** Check if the database connection is open */
  get isOpen(): boolean {
    return this.db.open;
  }

  get readOnly(): boolean {
    return this._readOnly;
  }
}
