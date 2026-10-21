import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  CaptureWebScreenshotInput,
  WebScreenshot,
} from "../domain/webScreenshot.js";
import { createWebScreenshotArtifact } from "../domain/webScreenshot.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { cdpFrameIdentity } from "./CdpCaptureEventHelpers.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import { recordValue, cdpStringValue } from "./CdpCaptureValues.js";
import {
  observeCdpFrameUrl,
  observeMainFrameUrl,
  classifyCdpFrameUrl,
  captureFrames,
} from "./CdpCaptureDocuments.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { decodeCanonicalBase64 } from "../domain/webScreenshot.js";
import { readPngHeaderDimensions } from "../domain/pngHeader.js";

interface ScreenshotContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: CaptureWebScreenshotInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

/** Capture the current viewport without navigation, evaluation, or page mutation. */
export const captureCdpScreenshot = async (
  context: ScreenshotContext,
): Promise<WebScreenshot> => {
  const origins = new Set(context.input.allowed_origins);
  await context.progress?.report({
    phase: "browser_observation",
    completed: 1,
    total: 2,
    message: "Authorizing current screenshot frame",
  });
  await context.connection.send(
    "Page.enable",
    {},
    context.sessionId,
    context.signal,
  );
  const before = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const beforeObservation = observeMainFrameUrl(before);
  const beforeFacts = classifyCdpFrameUrl(beforeObservation, origins);
  if (
    beforeFacts.scope === "outside_policy" ||
    beforeFacts.scope === "unsupported"
  )
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (beforeObservation.kind !== "observed")
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const beforeUrl = beforeFacts.url;
  const mainFrame = captureFrames(before, origins, 1).items[0];
  if (
    beforeUrl === undefined ||
    beforeFacts.origin === null ||
    mainFrame === undefined
  )
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const initialFrame = recordValue(
    recordValue(recordValue(before)?.frameTree)?.frame,
  );
  const navigation = {
    changed: false,
    leftScope: false,
    invalidIdentity: false,
    frameId: mainFrame.frame_id,

    url: beforeUrl,
    loaderId: cdpStringValue(initialFrame?.loaderId),
    completeness: new CdpCaptureCompleteness(),
  };
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    observeScreenshotNavigation(event, origins, navigation);
  });
  let result: ReturnType<typeof recordValue>;
  let after: unknown;
  try {
    result = recordValue(
      await context.connection.send(
        "Page.captureScreenshot",
        { format: "png", fromSurface: true, captureBeyondViewport: false },
        context.sessionId,
        context.signal,
      ),
    );
    after = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
  } finally {
    removeListener();
  }
  const screenshot = decodeScreenshot(result);
  if (screenshot === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  if (navigation.leftScope)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const afterObservation = observeMainFrameUrl(after);
  const afterFacts = classifyCdpFrameUrl(afterObservation, origins);
  if (
    afterFacts.scope === "outside_policy" ||
    afterFacts.scope === "unsupported"
  )
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (navigation.invalidIdentity || afterObservation.kind !== "observed")
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const afterUrl = afterFacts.url;
  if (navigation.changed || afterUrl !== beforeUrl || afterUrl === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
  await context.progress?.report({
    phase: "browser_observation",
    completed: 2,
    total: 2,
    message: "Screenshot capture complete",
    terminal: true,
  });
  return {
    browser: context.discovery.version,
    target: {
      target_id: context.target.id,
      url: beforeUrl,
      origin: beforeFacts.origin,
    },
    captured_at: new Date().toISOString(),
    viewport: screenshot.dimensions,
    artifact: createWebScreenshotArtifact(screenshot.bytes),
    completeness: navigation.completeness.snapshot(),
    limitations: [
      "The screenshot contains the visible viewport, including on-screen content.",
      "REA does not scroll, evaluate JavaScript, or capture beyond the current viewport.",
    ],
  };
};

const decodeScreenshot = (
  result: ReturnType<typeof recordValue>,
):
  | {
      readonly bytes: Buffer;
      readonly dimensions: { width: number; height: number };
    }
  | undefined => {
  const encoded = cdpStringValue(result?.data);
  const bytes =
    encoded === undefined ? undefined : decodeCanonicalBase64(encoded);
  if (bytes === undefined) return undefined;
  const dimensions = readPngHeaderDimensions(bytes);
  return dimensions === undefined ? undefined : { bytes, dimensions };
};

const observeScreenshotNavigation = (
  event: CdpEvent,
  origins: ReadonlySet<string>,
  state: {
    changed: boolean;
    leftScope: boolean;
    invalidIdentity: boolean;
    frameId: string;
    url: string | undefined;
    loaderId: string | undefined;
    readonly completeness: CdpCaptureCompleteness;
  },
): void => {
  const identity = cdpFrameIdentity(event, state.frameId);
  if (identity.applicability === "not_applicable") return;
  if (identity.identityIssue !== null || identity.parentIssue !== null) {
    state.completeness.exclude("screenshot", "invalid_protocol_value");
    if (
      identity.selection === "unknown" &&
      identity.parentRelation === "child" &&
      identity.identityIssue !== null
    )
      return;
    state.invalidIdentity = true;
    return;
  }
  if (identity.selection === "unknown") {
    if (identity.parentRelation === "child") return;
    state.completeness.exclude("screenshot", "invalid_protocol_value");
    state.invalidIdentity = true;
    return;
  }
  if (identity.selection === "other" && !identity.isRootReplacement) return;
  const params = recordValue(event.params);
  if (params === undefined) return;
  // A requested navigation does not establish a committed document change.
  // The frame-tree read after capture still verifies the selected URL.
  if (event.method === "Page.frameRequestedNavigation") return;
  const frame =
    event.method === "Page.frameNavigated" ? recordValue(params.frame) : params;
  const observed = observeCdpFrameUrl(frame);
  const facts = classifyCdpFrameUrl(observed, origins);
  const frameUrl = facts.url;
  if (
    event.method === "Page.navigatedWithinDocument" &&
    state.loaderId !== undefined &&
    state.loaderId !== "" &&
    frameUrl === state.url
  )
    return;
  if (
    event.method === "Page.frameNavigated" &&
    !identity.isRootReplacement &&
    state.loaderId !== undefined &&
    state.loaderId !== "" &&
    cdpStringValue(frame?.loaderId) === state.loaderId &&
    frameUrl === state.url
  )
    return;

  state.changed = true;
  if (facts.scope === "outside_policy" || facts.scope === "unsupported")
    state.leftScope = true;
  if (observed.kind !== "observed") state.invalidIdentity = true;
  if (event.method === "Page.frameNavigated") {
    if (identity.isRootReplacement)
      state.frameId = identity.frameId ?? state.frameId;
    state.url = frameUrl ?? state.url;
    state.loaderId = cdpStringValue(frame?.loaderId);
  } else if (event.method === "Page.navigatedWithinDocument") {
    state.url = frameUrl ?? state.url;
  }
};
