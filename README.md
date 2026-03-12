# rfcs.graphql.org

Static GraphQL RFC publishing pipeline.

This repo does two separate jobs:

1. `yarn sync-rfcs`
   Fetches RFC-related data from GitHub and from a local checkout of
   `graphql/graphql-wg`, then writes plain markdown and JSON into `generated/`.

2. `yarn build-site`
   Reads only the generated markdown and JSON, renders it through a trusted
   markdown pipeline, and emits static HTML into `dist/`.

There is no MDX in the pipeline and no execution of content-provided code.
Untrusted GitHub-flavoured markdown is treated as data throughout.

## Requirements

- Node 24+
- Yarn 1.x
- `git`
- `GITHUB_TOKEN`

`GITHUB_TOKEN` is required because the sync step queries the GitHub GraphQL API.

## Commands

- `yarn typecheck`
- `yarn sync-rfcs`
- `yarn build-site`
- `yarn build`

`yarn build` runs the full pipeline and produces a deployable `dist/`.

## Output

- `generated/site.json`
- `generated/rfcs/*.md`
- `dist/**/*.html`

## Deployment

GitHub Pages deployment is configured in
[`deploy.yml`](/home/benjaie/Dev/graphql/rfcs.graphql.org/.github/workflows/deploy.yml).
It runs daily on cron, on manual dispatch, and on pushes to `main`.

For Vercel or any other static host, the build output is simply `dist/`.
