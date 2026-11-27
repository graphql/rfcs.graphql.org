const repositoryRenames: Record<string, string> = {
  "facebook/graphql": "graphql/graphql-spec",
  "facebook/graphql-spec": "graphql/graphql-spec",
  "facebook/graphql-js": "graphql/graphql-js",
  "robrichard/defer-stream-wg": "graphql/defer-stream-wg",
  "graphql/composite-schemas-spec": "graphql/graphql-federation-spec",
};

// Normalize references for matching without rewriting the source Markdown.
export function normalizeGithubReferences(text: string): string {
  return text.replace(
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?=[/?#]|$)|(?<![\w./-])([\w.-]+\/[\w.-]+)(?=#\d+\b)/gi,
    (reference, urlRepo: string | undefined, shortRepo: string | undefined) => {
      const repo = (urlRepo ?? shortRepo!).toLowerCase();
      const renamed = repositoryRenames[repo] ?? repo;
      return urlRepo ? `https://github.com/${renamed}` : renamed;
    },
  );
}
