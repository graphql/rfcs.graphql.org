// Add a tracked repository with {} to scan its rfcs/ directory. Entries map
// exact filenames to proposal numbers when the introducing PR is ambiguous
// or points to a different proposal. See “Project RFC documents” in README.md.
export const documentOrigins: Record<string, Record<string, number>> = {
  "graphql-federation-spec": {},
  "golden-path-wg": {},
  "composite-schemas-wg": {},
  "ai-wg": {
    "semantic-introspection.md": 64,
    "relay_style_mock_store.pdf": 165,
  },
  "graphql-over-http": {
    "Batching.md": 40,
    "GraphQLOverSSE.md": 163,
    "GraphQLOverWebSocket.md": 140,
    "IncrementalDelivery.md": 124,
    "PersistedOperations.md": 253,
  },
};

// Each source keeps its public RFC prefix. Sources listed together share one
// RFC index, activity feed, and meeting series.
export const projectFilters = [
  {
    alias: "graphql",
    name: "GraphQL Spec",
    meetingGroup: "graphql-wg",
    sources: [],
  },
  {
    alias: "http",
    name: "GraphQL over HTTP",
    meetingGroup: "graphql-over-http",
    sources: [{ alias: "http", repo: "graphql-over-http" }],
  },
  {
    alias: "ai",
    name: "AI WG",
    meetingGroup: "ai-wg",
    sources: [{ alias: "ai", repo: "ai-wg" }],
  },
  {
    alias: "compwg",
    name: "Composite Schemas WG",
    meetingGroup: "composite-schemas-wg",
    sources: [
      { alias: "compwg", repo: "composite-schemas-wg" },
      { alias: "fed", repo: "graphql-federation-spec" },
    ],
  },
  {
    alias: "ide",
    name: "GraphiQL",
    meetingGroup: "graphiql",
    sources: [{ alias: "ide", repo: "graphiql" }],
  },
  {
    alias: "js",
    name: "GraphQL.js",
    meetingGroup: "graphql-js-wg",
    sources: [
      { alias: "js", repo: "graphql-js" },
      { alias: "jswg", repo: "graphql-js-wg" },
    ],
  },
  {
    alias: "gold",
    name: "Golden Path",
    meetingGroup: "golden-path-wg",
    sources: [{ alias: "gold", repo: "golden-path-wg" }],
  },
  { alias: "gap", name: "GAPs", sources: [{ alias: "gap", repo: "gaps" }] },
];

export const projects = projectFilters.flatMap((project) => project.sources);

export const projectName = (identifier: string) =>
  projectFilters.find((project) =>
    project.sources.some(({ alias }) => identifier.startsWith(alias + "-")),
  )?.name ?? "GraphQL Spec";
