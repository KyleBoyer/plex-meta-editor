import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DbCheckResult } from '@plex-meta-editor/shared';
import type { AppConfig } from '../config.js';
import type { SqlStatement } from '../plex/mutations.js';

const execFileAsync = promisify(execFile);

interface ExecSqlOptions {
  readOnly: boolean;
}

export class PlexSqliteUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = 'PlexSqliteUnavailableError';
  }
}

export class PlexSqliteService {
  private readonly dbPath: string;
  private readonly busyTimeout: number;
  private readonly binaryPath: string | null;
  private readonly available: boolean;
  private readonly startupError: string | null;

  constructor(config: AppConfig) {
    this.dbPath = config.dbPath;
    this.busyTimeout = config.busyTimeout;
    this.binaryPath = config.plexSqlitePath;
    this.available = config.plexSqliteAvailable;
    this.startupError = config.plexSqliteStartupError;
  }

  isAvailable(): boolean {
    return this.available && !!this.binaryPath;
  }

  getUnavailableReason(): string | null {
    if (this.isAvailable()) return null;
    return this.startupError || 'Official Plex SQLite is unavailable. Mutating routes are disabled in read-only mode.';
  }

  async executeTransaction(statements: SqlStatement[]): Promise<void> {
    this.assertAvailable();

    const renderedStatements = statements.map(statement => bindSqlStatement(statement.sql, statement.params));
    const script = [
      `PRAGMA busy_timeout = ${this.busyTimeout};`,
      'PRAGMA foreign_keys = ON;',
      'PRAGMA journal_mode = WAL;',
      'PRAGMA synchronous = NORMAL;',
      'BEGIN IMMEDIATE;',
      ...renderedStatements,
      'COMMIT;',
      '',
    ].join('\n');

    await this.runSqlScript(script, { readOnly: false });
  }

  async runIntegrityCheck(trigger: DbCheckResult['trigger']): Promise<DbCheckResult> {
    this.assertAvailable();

    const startedAt = Date.now();
    try {
      const stdout = await this.runSqlScript('PRAGMA integrity_check;\n', { readOnly: true });
      const issues = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      const ok = issues.length === 1 && issues[0] === 'ok';

      return {
        ok,
        issues: ok ? [] : issues,
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        checker: 'plex-sqlite',
        trigger,
      };
    } catch (err) {
      return {
        ok: false,
        issues: [err instanceof Error ? err.message : String(err)],
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        checker: 'plex-sqlite',
        trigger,
      };
    }
  }

  private assertAvailable(): void {
    const reason = this.getUnavailableReason();
    if (reason) {
      throw new PlexSqliteUnavailableError(reason);
    }
  }

  private async runSqlScript(sql: string, options: ExecSqlOptions): Promise<string> {
    if (!this.binaryPath) {
      throw new PlexSqliteUnavailableError('Official Plex SQLite is unavailable.');
    }

    const args = ['-batch', '-bail', '-noheader', '-list'];
    if (options.readOnly) {
      args.push('-readonly');
    }
    args.push(this.dbPath);

    try {
      const { stdout } = await execFileWithInput(this.binaryPath, args, sql);
      return stdout.trim();
    } catch (err) {
      throw new Error(formatExecFileError(err));
    }
  }
}

async function execFileWithInput(file: string, args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  const child = execFileAsync(
    file,
    args,
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  child.child.stdin?.end(input);

  const { stdout, stderr } = await child;
  return { stdout, stderr };
}

function formatExecFileError(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err);
  }

  const message = 'message' in err && typeof err.message === 'string' ? err.message : 'Plex SQLite execution failed';
  const stderr = 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : '';
  if (stderr) {
    return `${message}: ${stderr}`;
  }
  return message;
}

export function bindSqlStatement(sql: string, params: unknown[]): string {
  let output = '';
  let paramIndex = 0;
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' = 'normal';

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === 'normal') {
      if (char === '-' && next === '-') {
        state = 'line-comment';
        output += char;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        output += char;
        continue;
      }
      if (char === '\'') {
        state = 'single';
        output += char;
        continue;
      }
      if (char === '"') {
        state = 'double';
        output += char;
        continue;
      }
      if (char === '`') {
        state = 'backtick';
        output += char;
        continue;
      }
      if (char === '?') {
        if (paramIndex >= params.length) {
          throw new Error(`SQL placeholder mismatch: expected more bound values for "${sql}"`);
        }
        output += toSqlLiteral(params[paramIndex]);
        paramIndex++;
        continue;
      }
      output += char;
      continue;
    }

    output += char;

    if (state === 'single') {
      if (char === '\'' && next === '\'') {
        output += next;
        i++;
        continue;
      }
      if (char === '\'') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'double') {
      if (char === '"') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'backtick') {
      if (char === '`') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'block-comment' && char === '*' && next === '/') {
      output += next;
      i++;
      state = 'normal';
    }
  }

  if (paramIndex !== params.length) {
    throw new Error(`SQL placeholder mismatch: statement expected ${paramIndex} parameters but received ${params.length}`);
  }

  return output.endsWith(';') ? output : `${output};`;
}

function toSqlLiteral(value: unknown): string {
  if (value === null) {
    return 'NULL';
  }
  if (value === undefined) {
    throw new Error('SQL binding does not support undefined values');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`SQL binding does not support non-finite numbers: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, '\'\'')}'`;
  }

  throw new Error(`SQL binding does not support values of type ${typeof value}`);
}
