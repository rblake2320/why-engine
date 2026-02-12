import path from "path";
import fs from "fs";

export function getWhyEngineRoot(repoPath: string): string {
  return path.resolve(repoPath, ".why-engine");
}

export function assertPathUnder(basePath: string, targetPath: string): void {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  if (base === target) {
    return;
  }
  if (!target.startsWith(base + path.sep)) {
    throw new Error(`Path is outside allowed root: ${target}`);
  }
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function assertSafeId(value: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error("Unsafe id value");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error("Unsafe id value");
  }
}

export function assertSafeRepoPath(repoPath: string): void {
  if (repoPath.includes("..") || repoPath.includes("\0")) {
    throw new Error("Unsafe repoPath");
  }
}
