import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const frameRateCache = new Map<string, number | null>();
const frameRateInflight = new Map<string, Promise<number | null>>();

let ffprobeCommandPromise: Promise<string | null> | null = null;

export async function getMediaFrameRate(filePath: string): Promise<number | null> {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  if (frameRateCache.has(filePath)) {
    return frameRateCache.get(filePath) ?? null;
  }

  const inflight = frameRateInflight.get(filePath);
  if (inflight) {
    return inflight;
  }

  const probe = probeFrameRate(filePath)
    .then((frameRate) => {
      frameRateCache.set(filePath, frameRate);
      return frameRate;
    })
    .finally(() => {
      frameRateInflight.delete(filePath);
    });

  frameRateInflight.set(filePath, probe);

  return probe;
}

async function probeFrameRate(filePath: string): Promise<number | null> {
  const ffprobeCommand = await resolveFfprobeCommand();
  if (!ffprobeCommand) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      ffprobeCommand,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=avg_frame_rate,r_frame_rate',
        '-of', 'json',
        filePath,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
    );

    const payload = JSON.parse(stdout) as {
      streams?: Array<{
        avg_frame_rate?: string;
        r_frame_rate?: string;
      }>;
    };

    const stream = payload.streams?.[0];
    const frameRate = parseFrameRate(stream?.avg_frame_rate) ?? parseFrameRate(stream?.r_frame_rate);

    return isValidFrameRate(frameRate) ? frameRate : null;
  } catch {
    return null;
  }
}

async function resolveFfprobeCommand(): Promise<string | null> {
  if (!ffprobeCommandPromise) {
    ffprobeCommandPromise = (async () => {
      for (const candidate of getFfprobeCandidates()) {
        try {
          await execFileAsync(candidate, ['-version'], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 64 * 1024,
          });
          return candidate;
        } catch {
          continue;
        }
      }

      return null;
    })();
  }

  return ffprobeCommandPromise;
}

function getFfprobeCandidates(): string[] {
  const envPath = process.env.FFPROBE_PATH?.trim();

  switch (process.platform) {
    case 'darwin':
      return uniqueCandidates([
        envPath,
        'ffprobe',
        '/opt/homebrew/bin/ffprobe',
        '/usr/local/bin/ffprobe',
      ]);
    case 'win32':
      return uniqueCandidates([
        envPath,
        'ffprobe',
        'ffprobe.exe',
        'C:\\ffmpeg\\bin\\ffprobe.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe',
      ]);
    default:
      return uniqueCandidates([
        envPath,
        'ffprobe',
        '/usr/bin/ffprobe',
        '/usr/local/bin/ffprobe',
      ]);
  }
}

function uniqueCandidates(candidates: Array<string | undefined>): string[] {
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function parseFrameRate(value?: string): number | null {
  if (!value) {
    return null;
  }

  if (value.includes('/')) {
    const [numeratorRaw, denominatorRaw] = value.split('/', 2);
    const numerator = Number(numeratorRaw);
    const denominator = Number(denominatorRaw);

    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return null;
    }

    return numerator / denominator;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isValidFrameRate(frameRate: number | null): frameRate is number {
  return frameRate !== null && Number.isFinite(frameRate) && frameRate > 0.1 && frameRate <= 1000;
}
