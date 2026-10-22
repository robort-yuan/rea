import { Cli, z } from "incur";

import {
  compareEvidenceBundlesCommand,
  exportEvidenceBundleCommand,
  importEvidenceBundleCommand,
} from "./application/EvidenceBundleCommands.js";
import { clusterArtifactEvidenceCommand } from "./application/artifacts/ArtifactFamilyClusteringCommand.js";
import { logCliCommand } from "./cliLogging.js";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { ARTIFACT_FAMILY_MEMBER_LIMIT } from "./domain/artifactFamilyClustering.js";
import type { JsonValue } from "./domain/jsonValue.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { AnalysisError } from "./domain/analysisErrorBase.js";

/** Register caller-path Evidence commands. */
export const registerEvidenceCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.evidenceImport, {
    description: "Validate and import a bounded local Evidence bundle",
    args: z.object({
      path: z.string().describe("Evidence bundle JSON path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "evidence-import", async () => {
        const imported = await importEvidenceBundleCommand(args.path);
        return imported.ok ? imported.value : cliError(imported.error);
      }),
  });
  cli.command(CLI_COMMANDS.evidenceExport, {
    description: "Validate and atomically export canonical Evidence JSON",
    args: z.object({
      source: z.string().describe("Existing evidence bundle JSON path"),
      output: z.string().describe("Canonical output JSON path"),
    }),
    options: z.object({
      overwrite: z.boolean().default(false).describe("Replace output file"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "evidence-export", async () => {
        const exported = await exportEvidenceBundleCommand(
          args.source,
          args.output,
          options.overwrite,
        );
        return exported.ok ? exported.value : cliError(exported.error);
      }),
  });
  cli.command(CLI_COMMANDS.clusterArtifacts, {
    description:
      "Cluster artifact inventories into families and index shared members",
    options: z.object({
      member: z
        .array(z.string())
        .min(2)
        // The CLI has no schema of its own to fall back on: every document is
        // read and parsed before clustering, so the bound is enforced here too.
        .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
        .describe(
          "Evidence JSON path for one artifact inventory; repeat for every member",
        ),
      "shared-member-minimum": z
        .number()
        .int()
        .min(2)
        .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
        .optional()
        .describe(
          "Members a graph member must appear in to count as shared; omitted means every member",
        ),
      offset: z.number().int().min(0).default(0).describe("First family row"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum family rows returned"),
    }),
    run: ({ options }) =>
      logCliCommand(logger, CLI_COMMANDS.clusterArtifacts, async () => {
        const clustered = await clusterArtifactEvidenceCommand({
          memberPaths: options.member,
          ...(options["shared-member-minimum"] === undefined
            ? {}
            : { sharedMemberMinimum: options["shared-member-minimum"] }),
          offset: options.offset,
          limit: options.limit,
        });
        return clustered.ok ? clustered.value : cliError(clustered.error);
      }),
  });
  cli.command(CLI_COMMANDS.compare, {
    aliases: ["compare-bundles"],
    description: "Compare two canonical Evidence bundles",
    args: z.object({
      left: z.string().describe("Left Evidence bundle JSON path"),
      right: z.string().describe("Right Evidence bundle JSON path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "compare", async () => {
        const compared = await compareEvidenceBundlesCommand({
          leftPath: args.left,
          rightPath: args.right,
        });
        return compared.ok ? compared.value : cliError(compared.error);
      }),
  });
};

const cliError = (error: AnalysisError): JsonValue => ({
  error: "Analysis failed",
  ...projectAnalysisError(error),
});
