import { expect, it } from "vitest";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";
import { queryJavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticQuery.js";

it.each([
  ["binding", "speed = accel; return speed;", "speed"],
  ["property", "state.speed = accel; return state.speed;", "read:/speed"],
  ["compound", "state.speed += accel; return state.speed;", "read:/speed"],
  ["logical", "state.speed ||= accel; return state.speed;", "read:/speed"],
  ["nested", "speed = (state.speed = accel); return speed;", "speed"],
  ["property input", "speed = input.accel; return speed;", "speed"],
])("traces assignment influence through %s", (_name, body, reached) => {
  const graph = graphForJavaScript(`
    const accel = 0.001;
    const input = { accel: 0.001 };
    let speed = 6;
    const state = { speed: 6 };
    export function update() { ${body} }
  `);
  const trace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: 0.001 },
    direction: "forward-influence",
    include_ambiguous_dynamic_edges: true,
  });
  expect(trace.nodes.map((node) => node.label)).toContain(reached);
  expect(trace.nodes.map((node) => node.label)).toContain("return");
  expect(
    trace.relations.some(
      (edge) => edge.properties.assignment_operator !== undefined,
    ),
  ).toBe(true);
});

it("does not attribute deferred callback reads to an enclosing assignment", () => {
  const graph = graphForJavaScript(`
    const accel = 0.001;
    let callback;
    callback = () => accel;
  `);
  const trace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: 0.001 },
    direction: "forward-influence",
  });
  expect(
    trace.nodes
      .filter((node) => node.kind === "binding")
      .map((node) => node.label),
  ).not.toContain("callback");
});

it("retains both compound operands without assigning the RHS value to the destination", () => {
  const graph = graphForJavaScript(`
    const accel = 0.001;
    let speed = 6;
    speed += accel;
  `);
  const edges = graph.relations.filter(
    (edge) => edge.properties.assignment_operator === "+=",
  );
  expect(edges).toHaveLength(2);
  expect(
    edges
      .map(
        (edge) =>
          graph.nodes.find((node) => node.node_id === edge.source_node_id)
            ?.label,
      )
      .sort(),
  ).toEqual(["accel", "speed"]);
  const speed = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "speed",
  );
  expect(
    graph.unknowns.some(
      (item) =>
        item.node_id === speed?.node_id && item.reason === "unknown-value",
    ),
  ).toBe(true);
});

it("reaches a property write by default and keeps uncertain later reads opt-in", () => {
  const graph = graphForJavaScript(
    "const accel = 0.001; const state = {speed: 6}; function update() { state.speed += accel; return state.speed; }",
  );
  const trace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: 0.001 },
    direction: "forward-influence",
  });
  expect(
    trace.nodes.some(
      (node) => node.kind === "property-slot" && node.label === "speed",
    ),
  ).toBe(true);
  expect(trace.nodes.map((node) => node.label)).not.toContain("read:/speed");
  expect(trace.unknowns.length).toBeGreaterThan(0);
});
