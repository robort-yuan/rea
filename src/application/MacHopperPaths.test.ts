import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  localMacHopperRenamedLauncherCandidates,
  macHopperCanonicalLauncherCandidates,
  macHopperRenamedLauncherCandidates,
  readMacHopperRenamedLauncherCandidates,
} from "./MacHopperPaths.js";

describe("macOS Hopper launcher paths", () => {
  const home = "/fixture/home";

  it("keeps canonical system and user candidates ahead of renamed bundles", () => {
    expect(macHopperCanonicalLauncherCandidates(home)).toEqual([
      "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
      "/fixture/home/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    ]);
    expect(
      macHopperRenamedLauncherCandidates(
        home,
        new Map([
          [
            "/Applications",
            ["Hopper z.app", "Hopper a.app", "Hopper Disassembler.app"],
          ],
          ["/fixture/home/Applications", ["Hopper User.app"]],
        ]),
      ),
    ).toEqual([
      "/Applications/Hopper a.app/Contents/MacOS/hopper",
      "/Applications/Hopper z.app/Contents/MacOS/hopper",
      "/fixture/home/Applications/Hopper User.app/Contents/MacOS/hopper",
    ]);
  });

  it("finds the same renamed user bundles through runtime and doctor scans", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "rea-hopper-paths-"));
    const applications = join(temporary, "Applications");
    const appDirectory = join(applications, "Hopper Preview.app");
    try {
      await mkdir(appDirectory, { recursive: true });
      await mkdir(join(applications, "Hopper Disassembler.app"));
      await writeFile(join(applications, "Hopper File.app"), "");
      const runtime = [...localMacHopperRenamedLauncherCandidates(temporary)];
      expect(runtime).toContain(join(appDirectory, "Contents/MacOS/hopper"));
      expect(runtime.filter((path) => path.startsWith(temporary))).toEqual([
        join(appDirectory, "Contents/MacOS/hopper"),
      ]);
      expect(await readMacHopperRenamedLauncherCandidates(temporary)).toEqual(
        runtime,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
