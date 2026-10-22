import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import type { JavaScriptDeobfuscationPort } from "../../application/javascript/JavaScriptDeobfuscationPort.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../../application/AnalysisProvider.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type { JavaScriptDeobfuscationInput } from "../../domain/javascript/javascriptDeobfuscation.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  prlimitArgumentVector,
  readLinuxResourceLimits,
} from "../../process/LinuxResourceLimits.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { ABORTED, waitForAbortable } from "../../process/AbortablePromise.js";
import { boundedUtf8Text } from "../../process/boundedUtf8Text.js";
import type {
  ProviderProcessRetainedOutput,
  ProviderProcessSupervisor,
} from "../../process/ProviderProcess.js";
import {
  executeJsRedox,
  type JsRedoxEngine,
  type JsRedoxRunRequest,
  type JsRedoxRunResult,
} from "./JsRedoxExecution.js";
import {
  JS_REDOX_LIMITS,
  JS_REDOX_PROVIDER_IDENTITY,
} from "./JsRedoxRelease.js";

const OPERATION = "deobfuscate_javascript_source";
const HOST_REQUIREMENT =
  "On Linux x64, provide an absolute REA_JS_REDOX_COMMAND pointing to js-redox deobfuscate-safe 0.1.1, util-linux prlimit, and an executable private runtime filesystem (TMPDIR must not be mounted noexec).";

export type JsRedoxLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

type PendingCleanup = {
  root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
  process: ProviderProcessSupervisor | undefined;
  tree: SafeOutputTree | undefined;
};

/** Caller-supplied js-redox adapter for proof-gated static JavaScript rewriting. */
export class JsRedoxProvider implements JavaScriptDeobfuscationPort {
  readonly #resources = new ArtifactResourceScope();
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup: PendingCleanup | undefined;
  #reportedCleanupErrors: WeakRef<ProviderCleanupError>[] = [];
  readonly #executionCleanup = new WeakMap<
    AnalysisExecution,
    ProviderCleanupError
  >();

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: JsRedoxLauncher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = async () => {
      const parent = await runtimeParent(environment);
      return PrivateRuntimeRoot.create({
        prefix: "rea-js-redox-",
        parent,
      });
    },
  ) {}

  deobfuscate(
    input: JavaScriptDeobfuscationInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing) return Promise.resolve(err(this.#closedError()));
    if (options?.signal?.aborted === true)
      return Promise.resolve(
        err(
          new AnalysisCancelledError(OPERATION, {
            cause: options.signal.reason,
          }),
        ),
      );
    const predecessor = this.#tail;
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    const operation = predecessor.then(() => {
      if (this.#closing) return err(this.#closedError());
      if (options?.signal?.aborted === true)
        return err(
          new AnalysisCancelledError(OPERATION, {
            cause: options.signal.reason,
          }),
        );
      return this.#deobfuscate(input, options, markAdmitted);
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return settleQueuedDeobfuscation(admitted, operation, options?.signal);
  }

  async #deobfuscate(
    input: JavaScriptDeobfuscationInput,
    options: ExecutionOptions | undefined,
    markAdmitted: () => void,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let artifactFailure: unknown;
    try {
      await this.#resources.retryCleanup();
    } catch (cause: unknown) {
      artifactFailure = cause;
    }
    const retained = await this.#retire({
      allowRuntime: !this.#resources.hasPending,
    });
    if (artifactFailure !== undefined || retained !== undefined)
      return err(
        this.#cleanupFailures([
          ...(artifactFailure === undefined ? [] : [artifactFailure]),
          ...(retained === undefined ? [] : [retained]),
        ]),
      );
    this.#resolveReportedCleanupErrorsIfClean();
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let tree: SafeOutputTree | undefined;
    let processOwner: ProviderProcessSupervisor | undefined;
    let execution: AnalysisExecution | undefined;
    let failure: unknown;
    try {
      if (options?.signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
        });
      markAdmitted();
      const engine = await this.#resolveEngine(options?.signal);
      const source = await this.#readInput(input.path, options?.signal);
      try {
        root = await this.createRuntime();
      } catch (cause: unknown) {
        if (options?.signal?.aborted)
          throw new AnalysisCancelledError(OPERATION, {
            cause: options.signal.reason,
          });
        const reason = `Cannot create the private js-redox runtime: ${failureMessage(cause)}`;
        throw new AnalysisCapabilityUnavailableError(
          JS_REDOX_PROVIDER_IDENTITY.id,
          OPERATION,
          reason,
          {
            cause,
            userMessage:
              "Set TMPDIR to an existing writable exec-capable filesystem and retry.",
          },
        );
      }
      try {
        tree = await SafeOutputTree.create(input.output_directory);
      } catch (cause: unknown) {
        if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
        throw new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["output_directory"],
            reason: "invalid_value",
            message: `Cannot create new deobfuscation directory ${input.output_directory}: ${failureMessage(cause)}`,
          },
        ]);
      }
      execution = await executeJsRedox({
        request: input,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        engine,
        source,
        runtimePath: root.path,
        tree,
        resourceScope: this.#resources,
        run: (request) => this.#run(engine, request),
      });
      await root.close();
      root = undefined;
      if (options?.signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
        });
      await tree.commit(options?.signal);
    } catch (cause: unknown) {
      failure = cause;
      if (cause instanceof OwnedCommandFailure)
        processOwner = cause.cleanupOwner;
    }
    if (failure === undefined)
      return execution === undefined
        ? err(
            new AnalysisOutputError(
              OPERATION,
              "Deobfuscation returned no execution",
            ),
          )
        : ok(execution);

    return this.#handleFailure({
      failure,
      root,
      tree,
      processOwner,
      execution,
      signal: options?.signal,
    });
  }

  async #handleFailure(state: {
    readonly failure: unknown;
    readonly root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    readonly tree: SafeOutputTree | undefined;
    readonly processOwner: ProviderProcessSupervisor | undefined;
    readonly execution: AnalysisExecution | undefined;
    readonly signal: AbortSignal | undefined;
  }): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (state.tree?.published === true && state.execution !== undefined) {
      this.#pendingCleanup = {
        root: state.root,
        process: state.processOwner,
        tree: state.tree,
      };
      const cleanup = this.#cleanupError(
        state.failure,
        state.root,
        state.tree,
        state.processOwner,
        this.#resources.cleanupResources,
      );
      this.#executionCleanup.set(state.execution, cleanup);
      return ok(state.execution);
    }
    const cleanupFailures: unknown[] = [];
    let failedTree = state.tree;
    if (failedTree !== undefined) {
      try {
        await failedTree.rollback();
        failedTree = undefined;
      } catch (cause: unknown) {
        cleanupFailures.push(cause);
      }
    }
    let failedRoot = state.root;
    if (failedRoot !== undefined && state.processOwner === undefined) {
      try {
        await failedRoot.close();
        failedRoot = undefined;
      } catch (cause: unknown) {
        cleanupFailures.push(cause);
      }
    }
    const artifactResources = this.#resources.cleanupResources;
    if (
      state.processOwner !== undefined ||
      failedTree !== undefined ||
      failedRoot !== undefined ||
      artifactResources.length > 0
    ) {
      if (
        state.processOwner !== undefined ||
        failedTree !== undefined ||
        failedRoot !== undefined
      )
        this.#pendingCleanup = {
          root: failedRoot,
          process: state.processOwner,
          tree: failedTree,
        };
      return err(
        this.#cleanupError(
          state.failure,
          failedRoot,
          failedTree,
          state.processOwner,
          artifactResources,
          cleanupFailures,
        ),
      );
    }
    return err(this.#projectFailure(state.failure, state.signal));
  }

  #cleanupError(
    failure: unknown,
    root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined,
    tree: SafeOutputTree | undefined,
    processOwner: ProviderProcessSupervisor | undefined,
    artifactResources: readonly string[] = [],
    cleanupFailures: readonly unknown[] = [],
  ): ProviderCleanupError {
    const causes = [failure, ...cleanupFailures];
    const cause =
      causes.length === 1
        ? failure
        : new AggregateError(
            causes,
            "Operation and initial cleanup both failed",
          );
    const error = new ProviderCleanupError(
      JS_REDOX_PROVIDER_IDENTITY.id,
      [
        ...(processOwner === undefined
          ? []
          : [processOwner.launch.ownership?.runId ?? "js-redox-worker"]),
        ...(tree === undefined ? [] : [tree.outputRoot]),
        ...(root === undefined ? [] : [root.path]),
        ...artifactResources,
      ],
      {
        previous_error: failureMessage(failure),
        ...(cleanupFailures.length === 0
          ? {}
          : { cleanup_failures: cleanupFailures.map(failureMessage) }),
      },
      { operation: OPERATION, cause },
    );
    return this.#trackCleanupError(error);
  }

  cleanupFailureForExecution(
    execution: AnalysisExecution,
  ): ProviderCleanupError | undefined {
    const cleanup = this.#executionCleanup.get(execution);
    return cleanup?.cleanupIncomplete === true ? cleanup : undefined;
  }

  async #resolveEngine(signal?: AbortSignal): Promise<JsRedoxEngine> {
    const configured = this.environment.REA_JS_REDOX_COMMAND;
    const configuredLimiter =
      this.environment.REA_JAVASCRIPT_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
    if (
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      configured === undefined ||
      !isAbsolute(configured) ||
      !isAbsolute(configuredLimiter)
    )
      throw new AnalysisCapabilityUnavailableError(
        JS_REDOX_PROVIDER_IDENTITY.id,
        OPERATION,
        HOST_REQUIREMENT,
        { userMessage: HOST_REQUIREMENT },
      );
    try {
      const command = await realpath(configured);
      await access(command, constants.R_OK | constants.X_OK);
      const executable = await readStableArtifact(
        command,
        JS_REDOX_LIMITS.executableBytes,
        signal,
        undefined,
        this.#resources,
      );
      const limiterCommand = await realpath(configuredLimiter);
      await access(limiterCommand, constants.X_OK);
      const limiterExecutable = await readStableArtifact(
        limiterCommand,
        JS_REDOX_LIMITS.executableBytes,
        signal,
        undefined,
        this.#resources,
      );
      return {
        configuredCommand: configured,
        command,
        sha256: executable.sha256,
        bytes: executable.bytes.length,
        executable: executable.bytes,
        limiter: {
          configuredCommand: configuredLimiter,
          command: limiterCommand,
          sha256: limiterExecutable.sha256,
          bytes: limiterExecutable.bytes.length,
          executable: limiterExecutable.bytes,
        },
      };
    } catch (cause: unknown) {
      if (signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
      const reason = `Configured js-redox or util-linux prlimit is unavailable: ${failureMessage(cause)}`;
      throw new AnalysisCapabilityUnavailableError(
        JS_REDOX_PROVIDER_IDENTITY.id,
        OPERATION,
        reason,
        { cause, userMessage: reason },
      );
    }
  }

  async #readInput(path: string, signal?: AbortSignal) {
    try {
      const source = await readStableArtifact(
        path,
        JS_REDOX_LIMITS.inputBytes,
        signal,
        undefined,
        this.#resources,
      );
      new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
      return source;
    } catch (cause: unknown) {
      if (signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
      throw new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Cannot read stable UTF-8 JavaScript input ${path}: ${failureMessage(cause)}`,
        },
      ]);
    }
  }

  async #bindLimiter(
    engine: JsRedoxEngine,
    runtimePath: string,
    signal?: AbortSignal,
  ) {
    const limiter = join(runtimePath, `prlimit-${randomUUID()}`);
    await writeFile(limiter, engine.limiter.executable, {
      flag: "wx",
      mode: 0o700,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      await access(limiter, constants.X_OK);
    } catch (cause: unknown) {
      if (signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
      throw new AnalysisCapabilityUnavailableError(
        JS_REDOX_PROVIDER_IDENTITY.id,
        OPERATION,
        "The private resource-limiter snapshot is not executable. Select an exec-capable TMPDIR; noexec runtime mounts are unsupported.",
        {
          cause,
          userMessage:
            "Set TMPDIR to a writable exec-capable filesystem and retry.",
        },
      );
    }
    const snapshot = await readStableArtifact(
      limiter,
      JS_REDOX_LIMITS.executableBytes,
      signal,
      undefined,
      this.#resources,
    );
    if (
      snapshot.sha256 !== engine.limiter.sha256 ||
      snapshot.bytes.length !== engine.limiter.bytes
    )
      throw new AnalysisOutputError(
        OPERATION,
        "Owned resource-limiter snapshot disagrees with the fingerprinted executable bytes.",
      );
    return {
      command: limiter,
      sha256: snapshot.sha256,
      bytes: snapshot.bytes.length,
    };
  }

  async #run(
    engine: JsRedoxEngine,
    request: JsRedoxRunRequest,
  ): Promise<JsRedoxRunResult> {
    const limiter = await this.#bindLimiter(
      engine,
      request.cwd,
      request.signal,
    );
    const limits = await readLinuxResourceLimits(
      {
        address_space_bytes: JS_REDOX_LIMITS.addressSpaceBytes,
        file_bytes: JS_REDOX_LIMITS.outputBytes,
        cpu_seconds: JS_REDOX_LIMITS.cpuSeconds,
      },
      this.#resources,
    );
    const limiterArguments = [
      ...prlimitArgumentVector(limits, request.command),
      ...request.arguments,
    ];
    const timeoutMs = remainingRunTimeoutMs(request.deadlineAt);
    let retainedOutput: ProviderProcessRetainedOutput | undefined;
    const snapshot = await runOwnedCommand(
      {
        command: limiter.command,
        arguments: limiterArguments,
        expectedCommand: null,
        runId: `rea-js-redox-${randomUUID()}`,
        cwd: request.cwd,
        hostEnvironment: this.environment,
        env: { TMPDIR: request.cwd, RAYON_NUM_THREADS: "1", NO_COLOR: "1" },
      },
      {
        timeoutMs,
        diagnosticBytes: JS_REDOX_LIMITS.diagnosticBytes,
        observeCompleted: (_snapshot, output) => {
          retainedOutput = output;
        },
      },
      {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
      },
    );
    if (retainedOutput === undefined)
      throw new AnalysisOutputError(
        OPERATION,
        "Owned js-redox command completed without retained diagnostics",
      );
    return {
      snapshot,
      retainedOutput,
      limiter: {
        snapshotPath: limiter.command,
        snapshotSha256: limiter.sha256,
        snapshotBytes: limiter.bytes,
        arguments: limiterArguments,
      },
    };
  }

  #projectFailure(cause: unknown, signal?: AbortSignal): AnalysisError {
    if (cause instanceof AnalysisCancelledError)
      return signal?.aborted
        ? new AnalysisCancelledError(OPERATION, {
            cause: signal.reason,
            partialObservation: cause.partialObservation,
          })
        : cause;
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof OwnedCommandFailure) {
      if (cause.reason === "cancelled")
        return new AnalysisCancelledError(OPERATION, {
          cause:
            signal?.aborted === true
              ? signal.reason
              : (cause.cancellation?.reason ?? cause),
        });
      if (cause.reason === "timeout")
        return new AnalysisTimeoutError(OPERATION, JS_REDOX_LIMITS.timeoutMs, {
          cause,
        });
      const resource =
        cause.reason === "output-limit"
          ? "capacity"
          : cause.snapshot?.signal === "SIGXCPU"
            ? "cpu"
            : cause.snapshot?.signal === "SIGXFSZ"
              ? "file-size"
              : undefined;
      if (resource !== undefined)
        return new AnalysisResourceConstraintError(
          OPERATION,
          resource,
          resource === "capacity"
            ? "Owned worker exceeded the bounded diagnostic output capacity."
            : `Owned worker exited with ${cause.snapshot?.signal}; consistent with the configured ${resource} limit, but the signal alone does not prove limit enforcement.`,
          {
            diagnostic_bytes_ceiling: JS_REDOX_LIMITS.diagnosticBytes,
            cpu_seconds_ceiling: JS_REDOX_LIMITS.cpuSeconds,
            file_bytes_ceiling: JS_REDOX_LIMITS.outputBytes,
          },
          { cause, diagnostics: ownedCommandDiagnostics(cause) },
        );
      return new ProviderAdapterError(
        JS_REDOX_PROVIDER_IDENTITY.id,
        OPERATION,
        {
          cause,
          diagnostics: ownedCommandDiagnostics(cause),
        },
      );
    }
    if (signal?.aborted)
      return new AnalysisCancelledError(OPERATION, { cause: signal.reason });
    return new ProviderAdapterError(JS_REDOX_PROVIDER_IDENTITY.id, OPERATION, {
      cause,
      diagnostics:
        cause instanceof OwnedCommandFailure
          ? ownedCommandDiagnostics(cause)
          : { reason: failureMessage(cause) },
    });
  }

  #closedError(): ProviderCleanupError {
    return new ProviderCleanupError(
      JS_REDOX_PROVIDER_IDENTITY.id,
      [],
      { reason: "Provider is closing" },
      { operation: OPERATION },
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#finishClose();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    try {
      await this.#tail;
      let artifactFailure: unknown;
      try {
        await this.#resources.close();
      } catch (cause: unknown) {
        artifactFailure = cause;
      }
      const retained = await this.#retire({
        allowRuntime: !this.#resources.hasPending,
      });
      if (artifactFailure !== undefined || retained !== undefined)
        throw this.#cleanupFailures([
          ...(artifactFailure === undefined ? [] : [artifactFailure]),
          ...(retained === undefined ? [] : [retained]),
        ]);
      this.#resolveReportedCleanupErrorsIfClean();
    } catch (cause: unknown) {
      this.#closePromise = undefined;
      throw cause;
    }
  }

  async #retire(
    options: { readonly allowRuntime?: boolean } = {},
  ): Promise<ProviderCleanupError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending === undefined) return undefined;
    const failures: unknown[] = [];
    if (pending.process !== undefined) {
      const stopped = await pending.process.stop();
      if (stopped.status === "incomplete") {
        failures.push(new Error(stopped.reason));
      } else {
        pending.process = undefined;
      }
    }
    if (pending.tree !== undefined) {
      const tree = pending.tree;
      try {
        await tree.rollback();
        pending.tree = undefined;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (
      pending.root !== undefined &&
      pending.process === undefined &&
      options.allowRuntime !== false
    ) {
      const runtime = pending.root;
      try {
        await runtime.close();
        pending.root = undefined;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (
      pending.process === undefined &&
      pending.tree === undefined &&
      pending.root === undefined
    )
      this.#pendingCleanup = undefined;
    return failures.length === 0 ? undefined : this.#cleanupFailures(failures);
  }

  #cleanupFailures(causes: readonly unknown[]): ProviderCleanupError {
    const cause =
      causes.length === 1
        ? causes[0]
        : new AggregateError(causes, "Multiple js-redox cleanup owners failed");
    return this.#trackCleanupError(
      new ProviderCleanupError(
        JS_REDOX_PROVIDER_IDENTITY.id,
        this.#cleanupResources(),
        { reason: causes.map(failureMessage).join("; ") },
        { operation: OPERATION, cause },
      ),
    );
  }

  #cleanupResources(): readonly string[] {
    const pending = this.#pendingCleanup;
    return [
      ...new Set([
        ...this.#resources.cleanupResources,
        ...(pending?.process === undefined
          ? []
          : [pending.process.launch.ownership?.runId ?? "js-redox-worker"]),
        ...(pending?.tree === undefined ? [] : [pending.tree.outputRoot]),
        ...(pending?.root === undefined ? [] : [pending.root.path]),
      ]),
    ];
  }

  #trackCleanupError(error: ProviderCleanupError): ProviderCleanupError {
    const provider = this;
    error.bindCleanupResourceOwner({
      get cleanupResources() {
        return provider.#cleanupResources();
      },
    });
    this.#reportedCleanupErrors = [
      ...this.#reportedCleanupErrors.filter(
        (reference) => reference.deref() !== undefined,
      ),
      new WeakRef(error),
    ];
    return error;
  }

  #resolveReportedCleanupErrorsIfClean(): void {
    if (this.#resources.hasPending || this.#pendingCleanup !== undefined)
      return;
    for (const reference of this.#reportedCleanupErrors)
      reference.deref()?.resolveCleanup();
    this.#reportedCleanupErrors = [];
  }
}

const remainingRunTimeoutMs = (deadlineAt: number): number => {
  const remaining = deadlineAt - performance.now();
  if (remaining <= 0)
    throw new AnalysisTimeoutError(OPERATION, JS_REDOX_LIMITS.timeoutMs);
  return Math.max(1, remaining);
};

const runtimeParent = async (
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> => {
  const configured = environment.TMPDIR;
  const selected =
    configured === undefined || configured.trim().length === 0
      ? "/tmp"
      : configured;
  return realpath(absoluteCallerPath(selected));
};

const FAILED_COMMAND_DIAGNOSTIC_TEXT_BYTES = 4_096;

const ownedCommandDiagnostics = (
  failure: OwnedCommandFailure,
): Readonly<Record<string, import("../../domain/jsonValue.js").JsonValue>> => {
  const snapshot = failure.snapshot;
  const stdout =
    snapshot === null
      ? undefined
      : boundedUtf8Text(
          snapshot.stdout.text,
          FAILED_COMMAND_DIAGNOSTIC_TEXT_BYTES,
        );
  const stderr =
    snapshot === null
      ? undefined
      : boundedUtf8Text(
          snapshot.stderr.text,
          FAILED_COMMAND_DIAGNOSTIC_TEXT_BYTES,
        );
  return {
    reason: failure.message,
    exit_code: snapshot?.exitCode ?? null,
    exit_signal: snapshot?.signal ?? null,
    diagnostic_truncated: snapshot?.diagnosticTruncated === true,
    stdout:
      snapshot === null || stdout === undefined
        ? null
        : {
            text: stdout.text,
            text_truncated: stdout.truncated,
            bytes: snapshot.stdout.observedBytes,
            retained_bytes: snapshot.stdout.bytes,
          },
    stderr:
      snapshot === null || stderr === undefined
        ? null
        : {
            text: stderr.text,
            text_truncated: stderr.truncated,
            bytes: snapshot.stderr.observedBytes,
            retained_bytes: snapshot.stderr.bytes,
          },
  };
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const settleQueuedDeobfuscation = async (
  admitted: Promise<void>,
  operation: Promise<Result<AnalysisExecution, AnalysisError>>,
  signal?: AbortSignal,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const first = await waitForAbortable(
    Promise.race([
      admitted.then(() => ({ kind: "admitted" }) as const),
      operation.then((result) => ({ kind: "settled", result }) as const),
    ]),
    signal,
  );
  if (first === ABORTED)
    return err(
      new AnalysisCancelledError(OPERATION, {
        cause: signal?.reason,
      }),
    );
  return first.kind === "settled" ? first.result : operation;
};
