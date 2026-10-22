import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeTestTemporaryPrefix } from "../../scripts/lib/test-temporary-ownership.mjs";

const denied = (operation: () => unknown): boolean => {
  try {
    operation();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM";
  }
};

const probePermissionDenial = (): boolean => {
  if (process.platform === "win32") return false;
  const root = mkdtempSync(
    join(tmpdir(), normalizeTestTemporaryPrefix("permission-denial-probe-")),
  );
  const file = join(root, "file");
  const unlistable = join(root, "unlistable");
  const writeOnly = join(root, "write-only");
  const readOnly = join(root, "read-only");
  const directories = [unlistable, writeOnly, readOnly];
  try {
    writeFileSync(file, "x");
    chmodSync(file, 0);
    mkdirSync(unlistable);
    chmodSync(unlistable, 0);
    mkdirSync(writeOnly);
    chmodSync(writeOnly, 0o333);
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    return (
      denied(() => readFileSync(file)) &&
      denied(() => readdirSync(unlistable)) &&
      denied(() => readdirSync(writeOnly)) &&
      denied(() => writeFileSync(join(readOnly, "entry"), "x"))
    );
  } finally {
    for (const directory of directories)
      if (existsSync(directory)) chmodSync(directory, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
};

/**
 * True only when this process is refused access by mode bits: unreadable files
 * and directories stay unreadable, and a read-only directory refuses new
 * entries. Root, and any process that keeps CAP_DAC_OVERRIDE or
 * CAP_DAC_READ_SEARCH, passes straight through those modes, so tests that
 * depend on a permission denial skip when this is false.
 */
export const permissionDenialEnforced: boolean = probePermissionDenial();
