import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { classifyClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { setupRegistrationCommand } from "../../../src/application/SetupHost.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// The bin shim aube (mise's npm backend) wrote for rea-agents 6.7.0.
const aubeShim = (target: string): string => `#!/bin/sh
# aube-bin-shim v2 target=${target}
link="$0"
hops=0
while [ -L "$link" ] && [ "$hops" -lt 40 ]; do
hops=$((hops+1))
target=$(readlink "$link")
case "$target" in
/*) link="$target" ;;
*)  link="$(dirname "$link")/$target" ;;
esac
done
basedir=$(dirname "$link")
export NODE_PATH="$basedir/..:$basedir/../.mise/node_modules"
if [ -x "$basedir/node" ]; then
  exec "$basedir/node" "$basedir/${target}" "$@"
else
  exec node "$basedir/${target}" "$@"
fi
`;

const storeTarget = (version: string): string =>
  `../.mise/rea-agents@${version}/node_modules/rea-agents/scripts/rea.mjs`;

/**
 * Lay out a mise install the way mise does: each version in its own directory
 * under `installs/rea`, and `latest` a symlink to the newest. Returns the
 * entrypoint and shim as REA sees them when launched through `latest`.
 */
const installWithMise = async (
  installs: string,
  version: string,
  shimTarget = storeTarget(version),
): Promise<{ entrypoint: string; shim: string }> => {
  const bin = join(installs, version, "node_modules", ".bin");
  const script = join(bin, storeTarget(version));
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, "#!/usr/bin/env node\n");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "rea"), aubeShim(shimTarget), { mode: 0o755 });
  await rm(join(installs, "latest"), { force: true });
  await symlink(`./${version}`, join(installs, "latest"));
  const latestBin = join(installs, "latest", "node_modules", ".bin");
  return {
    entrypoint: join(latestBin, storeTarget(version)),
    shim: join(latestBin, "rea"),
  };
};

const registerWithClaudeCode = async (
  home: string,
  command: readonly string[],
): Promise<void> => {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: { command: command[0], args: command.slice(1) },
      },
    }),
  );
};

const claudeCodeState = async (
  home: string,
  entrypoint: string,
): Promise<string | undefined> =>
  (
    await readClientRegistrationStatuses(home, entrypoint, {
      platform: "linux",
      environment: {},
    })
  ).find(({ client }) => client === "claude_code")?.state;

it.skipIf(process.platform === "win32")(
  "registers the aube bin shim, which stays aligned across a mise upgrade",
  async () => {
    const home = await createTestTempDirectory("rea-aube-registration-");
    const installs = join(home, "installs", "rea");
    const before = await installWithMise(installs, "6.7.0");

    const command = setupRegistrationCommand(
      "linux",
      undefined,
      before.entrypoint,
    );
    expect(command).toEqual([before.shim, "mcp"]);
    expect(classifyClientRegistrationCommand(command, before.entrypoint)).toBe(
      "owned",
    );
    await registerWithClaudeCode(home, command);
    expect(await claudeCodeState(home, before.entrypoint)).toBe("aligned");

    // mise installs the new version beside the old, repoints `latest`, and
    // prunes the old directory.
    const after = await installWithMise(installs, "6.8.0");
    await rm(join(installs, "6.7.0"), { recursive: true });
    expect(after.shim).toBe(before.shim);
    expect(
      setupRegistrationCommand("linux", undefined, after.entrypoint),
    ).toEqual(command);
    expect(await claudeCodeState(home, after.entrypoint)).toBe("aligned");
  },
);

it.skipIf(process.platform === "win32")(
  "reports a registered aube store script as stale so setup moves it to the shim",
  async () => {
    const home = await createTestTempDirectory("rea-aube-legacy-");
    const { entrypoint } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );

    await registerWithClaudeCode(home, [entrypoint, "mcp"]);
    expect(
      classifyClientRegistrationCommand([entrypoint, "mcp"], entrypoint),
    ).toBe("owned");
    expect(await claudeCodeState(home, entrypoint)).toBe("stale");
  },
);

it.skipIf(process.platform === "win32")(
  "owns a link to the shim, which runs the target beside the real shim",
  async () => {
    const home = await createTestTempDirectory("rea-aube-link-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const link = join(home, "bin", "rea");
    await mkdir(dirname(link), { recursive: true });
    await symlink(shim, link);

    expect(classifyClientRegistrationCommand([link, "mcp"], entrypoint)).toBe(
      "owned",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the script path when the shim does not run this entrypoint",
  async () => {
    const home = await createTestTempDirectory("rea-aube-foreign-shim-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
      "../.mise/other@1.0.0/node_modules/other/bin.js",
    );

    expect(setupRegistrationCommand("linux", undefined, entrypoint)).toEqual([
      entrypoint,
      "mcp",
    ]);
    expect(classifyClientRegistrationCommand([shim, "mcp"], entrypoint)).toBe(
      "foreign",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "ignores shims in a format it does not know",
  async () => {
    const home = await createTestTempDirectory("rea-aube-unknown-shim-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    await writeFile(
      shim,
      aubeShim(storeTarget("6.7.0")).replace(
        "aube-bin-shim v2",
        "aube-bin-shim v3",
      ),
    );

    expect(setupRegistrationCommand("linux", undefined, entrypoint)).toEqual([
      entrypoint,
      "mcp",
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "classifies a registered FIFO without blocking on it",
  async () => {
    const home = await createTestTempDirectory("rea-aube-fifo-");
    const { entrypoint } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const fifo = join(home, "rea-fifo");
    execFileSync("mkfifo", [fifo]);

    expect(classifyClientRegistrationCommand([fifo, "mcp"], entrypoint)).toBe(
      "foreign",
    );
  },
);
