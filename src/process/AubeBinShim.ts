import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// aube (the installer behind mise's npm backend) writes each package bin as a
// POSIX shell shim, not a symlink. The shim runs node on the script inside one
// version's store directory, so that versioned path is all `process.argv[1]`
// ever shows. The shim itself stays at a stable path across upgrades, and its
// second line names the script it runs, relative to the shim's directory.
const SHIM_HEADER = /^#!\/bin\/sh\n# aube-bin-shim v2 target=([^\n]+)\n/u;
const HEADER_BYTES = 512;

const readHeader = (path: string): string | undefined => {
  let descriptor: number | undefined;
  try {
    // Non-blocking, so a registered path naming a FIFO cannot stall the read.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) return undefined;
    const buffer = Buffer.alloc(HEADER_BYTES);
    const length = readSync(descriptor, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return undefined;
  } finally {
    // A failed close loses nothing here; it must not escape as a classification error.
    if (descriptor !== undefined)
      try {
        closeSync(descriptor);
      } catch {}
  }
};

const samePath = (left: string, right: string): boolean => {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
};

/** Absolute script an aube v2 shim runs, or undefined when it is not one. */
export const aubeShimTarget = (shimPath: string): string | undefined => {
  if (!isAbsolute(shimPath)) return undefined;
  const target = SHIM_HEADER.exec(readHeader(shimPath) ?? "")?.[1];
  if (target === undefined || isAbsolute(target)) return undefined;
  // The shim follows links to itself before taking its directory, so a link
  // to a shim runs the target beside the real file.
  try {
    return resolve(dirname(realpathSync.native(shimPath)), target);
  } catch {
    return undefined;
  }
};

/** Whether `shimPath` is an aube shim that runs exactly `entrypointPath`. */
export const aubeShimRunsEntrypoint = (
  shimPath: string,
  entrypointPath: string,
): boolean => {
  const target = aubeShimTarget(shimPath);
  return target !== undefined && samePath(target, entrypointPath);
};

/**
 * The aube shim that launched `entrypointPath`, found as `<dir>/.bin/<bin>`
 * beside an enclosing `node_modules` directory, or undefined when no shim
 * there runs this exact entrypoint. The outermost one wins: the entrypoint
 * sits under a nested `node_modules` inside the versioned store, and a shim
 * there would move with the version just like the script does.
 */
export const aubeShimLauncher = (
  entrypointPath: string,
  binName: string,
): string | undefined => {
  if (!isAbsolute(entrypointPath)) return undefined;
  let launcher: string | undefined;
  for (
    let directory = dirname(entrypointPath);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "node_modules") continue;
    const candidate = join(directory, ".bin", binName);
    if (aubeShimRunsEntrypoint(candidate, entrypointPath)) launcher = candidate;
  }
  return launcher;
};
