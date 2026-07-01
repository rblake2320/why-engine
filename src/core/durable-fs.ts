import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Durable filesystem primitives.
 *
 * Guarantees provided:
 * - atomicWriteFileSync: readers never observe a partially written file.
 *   Data is written to a temp file in the same directory, fsync'd, then
 *   renamed over the target. The directory is fsync'd afterwards so the
 *   rename itself survives a crash (POSIX). On Windows, directory fsync is
 *   skipped (not supported) but rename remains atomic on NTFS.
 * - appendLineDurable: the appended line is fsync'd to disk before return,
 *   so an acknowledged append is never lost to a crash. A crash *during*
 *   the append can still tear the final line; verifyAuditChain detects and
 *   classifies that case as a repairable torn tail.
 * - withLock: cross-process advisory lock using atomic mkdir. Stale locks
 *   (holder crashed) are broken after `staleMs`.
 */

export function atomicWriteFileSync(targetPath: string, data: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, targetPath);
  fsyncDirBestEffort(dir);
}

export function appendLineDurable(targetPath: string, line: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = fs.openSync(targetPath, "a");
  try {
    fs.writeFileSync(fd, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirBestEffort(dirPath: string): void {
  // Directory fsync is required on POSIX for rename durability; it throws
  // EISDIR/EPERM on Windows, where NTFS metadata journaling covers us.
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best effort on platforms without directory fsync */
  }
}

export interface LockOptions {
  /** Total time to wait for the lock before failing. Default 5000ms. */
  timeoutMs?: number;
  /** Age after which a lock is considered abandoned. Default 30000ms. */
  staleMs?: number;
  /** Poll interval while waiting. Default 25ms. */
  pollMs?: number;
}

/**
 * Acquire a cross-process advisory lock, run fn, release.
 * mkdir is atomic on every platform Node supports, which makes the lock
 * race-free without native deps. The lock dir contains an owner.json with
 * pid + timestamp so stale locks from crashed holders can be broken.
 */
export function withLock<T>(lockName: string, baseDir: string, fn: () => T, options: LockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30000;
  const pollMs = options.pollMs ?? 25;
  fs.mkdirSync(baseDir, { recursive: true });
  const lockDir = path.join(baseDir, `${lockName}.lock`);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break; // acquired
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (isLockStale(lockDir, staleMs)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* another process may have broken it first; retry */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${lockName} (held by another process?)`);
      }
      sleepSync(pollMs);
    }
  }

  try {
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8"
    );
  } catch {
    /* owner metadata is diagnostic only */
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function isLockStale(lockDir: string, staleMs: number): boolean {
  try {
    const stat = fs.statSync(lockDir);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    // Lock vanished between mkdir failure and stat: treat as breakable.
    return true;
  }
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}
