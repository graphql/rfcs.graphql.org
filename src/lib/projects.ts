export const projects = [
  { alias: "http", repo: "graphql-over-http", name: "GraphQL over HTTP" },
  { alias: "ai", repo: "ai-wg", name: "AI WG" },
  {
    alias: "compwg",
    repo: "composite-schemas-wg",
    name: "Composite Schemas WG",
  },
  { alias: "fed", repo: "graphql-federation-spec", name: "Federation Spec" },
  { alias: "ide", repo: "graphiql", name: "GraphiQL" },
  { alias: "js", repo: "graphql-js", name: "GraphQL.js" },
  { alias: "jswg", repo: "graphql-js-wg", name: "GraphQL.js WG" },
  { alias: "gold", repo: "golden-path-wg", name: "Golden Path" },
  { alias: "gap", repo: "gaps", name: "GAPs" },
];

export const projectName = (identifier: string) =>
  projects.find(({ alias }) => identifier.startsWith(alias + "-"))?.name ??
  "GraphQL";
