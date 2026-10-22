import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import {
  execFileOutput,
  ExecFileOutputCancelledError,
  execFileOutputFailure,
  type ExecFileOutputFailure,
} from "../process/ExecFileOutput.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

export const GHIDRA_LAUNCH_SUPPORT_CAPTURE_BYTES = 64 * 1024;
type LaunchSupportPhase = "-envvars" | "-vmargs";
type LaunchSupportOutcome = Omit<
  ExecFileOutputFailure,
  "killed" | "outputTruncated"
> & {
  readonly killed: boolean | null;
  readonly outputTruncated: boolean | null;
};

export class GhidraLaunchSupportError extends Error {
  readonly outcome: LaunchSupportOutcome | undefined;
  readonly cancellation: { readonly reason: unknown } | undefined;

  constructor(phase: LaunchSupportPhase, cause: unknown) {
    super(`Ghidra LaunchSupport ${phase} failed`, { cause });
    this.name = "GhidraLaunchSupportError";
    this.cancellation =
      cause instanceof ExecFileOutputCancelledError
        ? { reason: cause.cause }
        : undefined;
    const outcome = execFileOutputFailure(cause);
    this.outcome =
      outcome === undefined
        ? undefined
        : {
            ...outcome,
            killed: this.cancellation === undefined ? outcome.killed : null,
            outputTruncated:
              this.cancellation === undefined ? outcome.outputTruncated : null,
          };
  }
}

/** JVM option environments remove quotes, including quotes inside an option. */
const jvmEnvironmentArguments = (value: string): readonly string[] => {
  const arguments_: string[] = [];
  let argument = "";
  let quote: "'" | '"' | undefined;
  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else argument += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/u.test(character)) {
      if (argument !== "") arguments_.push(argument);
      argument = "";
    } else argument += character;
  }
  if (quote !== undefined)
    throw new Error(
      "Invalid quoted Ghidra LaunchSupport JVM environment option",
    );
  if (argument !== "") arguments_.push(argument);
  return arguments_;
};

const rejectJvmPlatformOverrides = (arguments_: readonly string[]): void => {
  if (
    arguments_.some((argument) => /^-Dos\.(?:arch|name)(?:=|$)/u.test(argument))
  )
    throw new Error(
      "Ghidra LaunchSupport may not override os.arch or os.name; the native decompiler was validated for the inspected JVM platform.",
    );
};

/** JDK_JAVA_OPTIONS is the only helper variable the JVM expands as @files. */
const JDK_JAVA_OPTIONS_ARGFILE_MAX_BYTES = 64 * 1024;

const isJdkJavaOptionsArgfileReference = (argument: string): boolean =>
  argument.startsWith("@") && !argument.startsWith("@@");

const unescapeJdkJavaOptionsAtArgument = (argument: string): string =>
  argument.startsWith("@@") ? argument.slice(1) : argument;

/** Argument files treat unquoted # as a comment through the end of the line. */
const stripJdkJavaOptionsArgfileComments = (value: string): string => {
  let result = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== undefined) {
      result += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === "#") {
      while (index + 1 < value.length) {
        const next = value[index + 1]!;
        if (next === "\n" || next === "\r") break;
        index += 1;
      }
      continue;
    }
    result += character;
  }
  return result;
};

const readJdkJavaOptionsArgfile = async (path: string): Promise<string> => {
  if (path === "" || path.includes("\0"))
    throw new Error(
      "Ghidra LaunchSupport JDK_JAVA_OPTIONS argument file is unreadable.",
    );
  let file;
  try {
    file = await open(path, "r");
  } catch (cause: unknown) {
    throw new Error(
      "Ghidra LaunchSupport JDK_JAVA_OPTIONS argument file is unreadable.",
      { cause },
    );
  }
  try {
    const bytes = await readBoundedFileBytes(
      file,
      JDK_JAVA_OPTIONS_ARGFILE_MAX_BYTES,
    );
    if (bytes === undefined)
      throw new Error(
        `Ghidra LaunchSupport JDK_JAVA_OPTIONS argument file exceeds the ${String(JDK_JAVA_OPTIONS_ARGFILE_MAX_BYTES)}-byte admission bound.`,
      );
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
};

const expandJdkJavaOptionsArguments = async (
  arguments_: readonly string[],
): Promise<readonly string[]> => {
  const expanded: string[] = [];
  for (const argument of arguments_) {
    if (!isJdkJavaOptionsArgfileReference(argument)) {
      expanded.push(unescapeJdkJavaOptionsAtArgument(argument));
      continue;
    }
    const nested = jvmEnvironmentArguments(
      stripJdkJavaOptionsArgfileComments(
        await readJdkJavaOptionsArgfile(argument.slice(1)),
      ),
    );
    for (const nestedArgument of nested) {
      if (isJdkJavaOptionsArgfileReference(nestedArgument))
        throw new Error(
          "Ghidra LaunchSupport JDK_JAVA_OPTIONS argument files may not nest @ references.",
        );
      expanded.push(unescapeJdkJavaOptionsAtArgument(nestedArgument));
    }
  }
  return expanded;
};

/** Launch coordinates obtained from Ghidra's own release configuration helper. */
export const ghidraJavaLaunch = async (options: {
  readonly platform: NodeJS.Platform;
  readonly analyzeHeadlessPath: string;
  readonly javaHome?: string;
  readonly javaVmName?: string;
  readonly homeRoot: string;
  readonly tempRoot: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onStderr: (mode: "-envvars" | "-vmargs", stderr: string) => void;
}): Promise<{
  readonly command: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  /** REA-configured -Xmx value, not effective or observed JVM memory. */
  readonly configuredMaxHeap?: string;
}> => {
  const supportRoot = dirname(options.analyzeHeadlessPath);
  const installRoot = dirname(supportRoot);
  const selectedJavaHome = options.javaHome ?? options.environment.JAVA_HOME;
  const command =
    selectedJavaHome === undefined
      ? options.platform === "win32"
        ? "java.exe"
        : "java"
      : join(
          selectedJavaHome,
          "bin",
          options.platform === "win32" ? "java.exe" : "java",
        );
  const isolatedProperties = [
    `-Duser.home=${options.homeRoot}`,
    `-Djava.io.tmpdir=${options.tempRoot}`,
  ];
  const supportArguments = [
    ...isolatedProperties,
    // Only identified HotSpot VMs have these unified-logging semantics. OpenJ9
    // uses different -Xlog behavior; missing VM identity must stay unknown.
    ...(/^(?:OpenJDK|Java HotSpot\(TM\)) (?:64-Bit )?(?:Server|Client|Zero) VM$/u.test(
      options.javaVmName ?? "",
    )
      ? ["-Xlog:disable", "-Xlog:all=warning:stderr"]
      : []),
    "-cp",
    join(supportRoot, "LaunchSupport.jar"),
    "LaunchSupport",
    installRoot,
  ];
  const environment = {
    ...snapshotEnvironment(options.environment, options.platform),
  };
  const supportOutput = async (phase: LaunchSupportPhase) => {
    try {
      return await execFileOutput(command, [...supportArguments, phase], {
        env: environment,
        maxBuffer: GHIDRA_LAUNCH_SUPPORT_CAPTURE_BYTES,
        // Wait for the helper's exit on abort so no probe outlives its owner.
        stopSignal: "SIGTERM",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause: unknown) {
      throw new GhidraLaunchSupportError(phase, cause);
    }
  };
  const configuredEnvironment = await supportOutput("-envvars");
  options.onStderr("-envvars", configuredEnvironment.stderr);
  for (const line of configuredEnvironment.stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const sourceKey = line.slice(0, separator);
    const key =
      options.platform === "win32" ? sourceKey.toUpperCase() : sourceKey;
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new Error(
        `Invalid Ghidra LaunchSupport environment entry: ${line}`,
      );
    if ((environment[key] ?? "") === "")
      environment[key] = line.slice(separator + 1);
  }
  const configuredMaxHeap =
    environment.GHIDRA_HEADLESS_MAXMEM || environment.GHIDRA_MAXMEM || "2G";
  // The merged environment becomes the analysis JVM's environment, and the
  // JVM applies these options variables automatically. An injected
  // -Dos.arch/-Dos.name there selects an unvalidated native directory without
  // appearing in vmArguments, so reject the effective values as well.
  // JDK_JAVA_OPTIONS is the only helper variable the launched JVM expands as
  // argument files. Inspect those effective tokens with the same
  // platform-override policy. JAVA_TOOL_OPTIONS and _JAVA_OPTIONS treat @file
  // as an unrecognized option rather than expanding it.
  for (const key of [
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
  ] as const) {
    const tokens = jvmEnvironmentArguments(environment[key] ?? "");
    rejectJvmPlatformOverrides(
      key === "JDK_JAVA_OPTIONS"
        ? await expandJdkJavaOptionsArguments(tokens)
        : tokens,
    );
  }
  const configuredArguments = await supportOutput("-vmargs");
  options.onStderr("-vmargs", configuredArguments.stderr);
  const vmArguments = configuredArguments.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  if (
    vmArguments.some(
      (argument) => !argument.startsWith("-") || argument.includes("\0"),
    )
  )
    throw new Error("Invalid Ghidra LaunchSupport JVM argument");
  rejectJvmPlatformOverrides(vmArguments);
  return {
    command,
    environment,
    configuredMaxHeap,
    arguments: [
      ...vmArguments,
      ...(options.platform === "darwin" ? ["-Xdock:name=Ghidra-Headless"] : []),
      `-Xmx${configuredMaxHeap}`,
      "-XX:ParallelGCThreads=2",
      "-XX:CICompilerCount=2",
      "-Djava.awt.headless=true",
      ...isolatedProperties,
      "-showversion",
      "-cp",
      join(installRoot, "Ghidra", "Framework", "Utility", "lib", "Utility.jar"),
      "ghidra.Ghidra",
      "ghidra.app.util.headless.AnalyzeHeadless",
      ...options.arguments,
    ],
  };
};
