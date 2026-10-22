import { describe, expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { observed } from "../../tests/fixtures/analysisExecution.js";
import type { AnalysisClient, AnalysisExecution } from "./AnalysisProvider.js";
import { readStandalonePlist } from "./StandalonePlistRead.js";

const PATH = "/fixture/Settings";

const client = (
  execute: AnalysisClient["execute"],
  closed: Result<null, ProviderAdapterError> = ok(null),
) => {
  const calls = { closes: 0, signals: [] as (AbortSignal | undefined)[] };
  const value: AnalysisClient = {
    execute: (operation, parameters, options) => {
      calls.signals.push(options?.signal);
      return execute(operation, parameters, options);
    },
    close: () => {
      calls.closes += 1;
      return Promise.resolve(closed);
    },
  };
  return { value, calls };
};

const cleanupFailure = () =>
  err(new ProviderAdapterError("fixture", "close_binary"));

describe("standalone plist reads", () => {
  it("returns the observation without a subject and closes the client once", async () => {
    const fixture = client((operation, parameters) => {
      expect(operation).toBe("inspect_plist");
      expect(parameters).toEqual({ path: PATH });
      return Promise.resolve(observed({ source_path: PATH }));
    });
    const result = await readStandalonePlist(
      fixture.value,
      "fixture",
      PATH,
      undefined,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { subject: null, result: { source_path: PATH } },
    });
    expect(fixture.calls.closes).toBe(1);
  });

  it("forwards cancellation, keeps the cancelled result, and still closes", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    const fixture = client((operation, _parameters, options) =>
      Promise.resolve<Result<AnalysisExecution, AnalysisCancelledError>>(
        err(
          new AnalysisCancelledError(operation, {
            cause: options?.signal?.reason,
          }),
        ),
      ),
    );
    const result = await readStandalonePlist(
      fixture.value,
      "fixture",
      PATH,
      controller.signal,
    );
    expect(fixture.calls.signals).toEqual([controller.signal]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
    expect(fixture.calls.closes).toBe(1);
  });

  it("reports a cleanup failure instead of a completed read", async () => {
    const fixture = client(
      () => Promise.resolve(observed({ source_path: PATH })),
      cleanupFailure(),
    );
    const result = await readStandalonePlist(
      fixture.value,
      "fixture",
      PATH,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("cleanup_incomplete");
      expect(projected.details).toMatchObject({
        diagnostics: { partial_observation: { result: { source_path: PATH } } },
      });
    }
    expect(fixture.calls.closes).toBe(1);
  });

  it("keeps a cancellation and its cleanup failure together", async () => {
    const fixture = client(
      (operation) =>
        Promise.resolve<Result<AnalysisExecution, AnalysisCancelledError>>(
          err(new AnalysisCancelledError(operation)),
        ),
      cleanupFailure(),
    );
    const result = await readStandalonePlist(
      fixture.value,
      "fixture",
      PATH,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: { diagnostics: { primary_error: { code: "cancelled" } } },
      });
    expect(fixture.calls.closes).toBe(1);
  });

  it("closes the client before rethrowing an unexpected read failure", async () => {
    const thrown = new Error("reader crashed");
    const fixture = client(() => Promise.reject(thrown));
    await expect(
      readStandalonePlist(fixture.value, "fixture", PATH, undefined),
    ).rejects.toBe(thrown);
    expect(fixture.calls.closes).toBe(1);
  });

  it("retains both failures when the read throws and cleanup fails", async () => {
    const thrown = new Error("reader crashed");
    const fixture = client(() => Promise.reject(thrown), cleanupFailure());
    const failure = await readStandalonePlist(
      fixture.value,
      "fixture",
      PATH,
      undefined,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(thrown);
    expect((failure as AggregateError).errors[1]).toBeInstanceOf(
      ProviderAdapterError,
    );
    expect(fixture.calls.closes).toBe(1);
  });
});
