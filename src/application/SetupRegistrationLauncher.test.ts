import { expect, it } from "vitest";

import { packageRunnerRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { setupRegistrationCommand } from "./SetupHost.js";
import { PRODUCT_IDENTITY } from "../identity.js";

const packageSpecifier = `${PRODUCT_IDENTITY.packageName}@${PRODUCT_IDENTITY.packageVersion}`;
const packageName = PRODUCT_IDENTITY.packageName;

/** A version-scoped store path such as a pnpm or aube/mise shim target. */
const storePath = (root: string, separator: string): string =>
  [
    root,
    "node_modules",
    ".mise",
    packageSpecifier,
    "node_modules",
    packageName,
    "scripts",
    "rea.mjs",
  ].join(separator);

it("registers a pinned package-runner launcher for a version-scoped store path", () => {
  const store = storePath(
    "/home/u/.local/share/mise/installs/npm-rea-agents/latest",
    "/",
  );
  expect(setupRegistrationCommand("linux", undefined, store)).toEqual(
    packageRunnerRegistrationCommand("npx", "linux"),
  );
  expect(
    setupRegistrationCommand(
      "win32",
      undefined,
      storePath(
        "C:\\Users\\a\\.local\\share\\mise\\installs\\npm-rea-agents\\latest",
        "\\",
      ),
    ),
  ).toEqual(packageRunnerRegistrationCommand("npx", "win32"));
});

it("keeps a direct launcher for store paths that do not depend on the release", () => {
  const stable = `/opt/rea/node_modules/${packageName}/scripts/rea.mjs`;
  expect(setupRegistrationCommand("linux", undefined, stable)).toEqual([
    stable,
    "mcp",
  ]);
  // Another version's segment is not this running package's store path.
  const otherVersion = storePath(
    "/home/u/.local/share/pnpm/global/5/.pnpm",
    "/",
  ).replace(packageSpecifier, `${packageName}@0.0.1`);
  expect(setupRegistrationCommand("linux", undefined, otherVersion)).toEqual([
    otherVersion,
    "mcp",
  ]);
  // An explicit package-runner invocation still wins over the fallback.
  const store = storePath(
    "/home/u/.local/share/mise/installs/npm-rea-agents/latest",
    "/",
  );
  expect(setupRegistrationCommand("linux", "bunx", store)).toEqual(
    packageRunnerRegistrationCommand("bunx", "linux"),
  );
});
