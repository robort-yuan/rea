import type { Client } from "@modelcontextprotocol/client";

type ArtifactMcpRequestOptions = Omit<
  NonNullable<Parameters<Client["callTool"]>[1]>,
  "toolDefinition"
>;

/** Call the tool using its connection-bound, advertised output schema. */
export function artifactMcpCall(
  client: Client,
  parameters: Parameters<Client["callTool"]>[0],
  options?: ArtifactMcpRequestOptions,
): ReturnType<Client["callTool"]>;
