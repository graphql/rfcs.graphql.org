# rfcs.graphql.org

RFC tracker for GraphQL. Gathers together RFCs from:

- graphql-spec issues
- graphql-spec PRs
- graphql-wg rfcs/ folder

Tracks commits, commentary, and stages. Interlinks based on heuristics. Also
fetches details of GraphQL Spec WG meetings to determine when each RFC has been
discussed, to allow looking up discussions in the recordings.

## Repo setup

This repo does two separate jobs:

1. `yarn sync-rfcs`
   Fetches RFC-related data from GitHub and from a local checkout of
   `graphql/graphql-wg`, then writes plain markdown and JSON into `generated/`.

2. `yarn build-site`
   Reads only the generated markdown and JSON, renders it through a markdown
   pipeline, and emits static HTML into `dist/`.

Since we're pulling markdown from easy-to-edit issues and PRs, we must treat it
as entirely untrusted. We treat this untrusted GitHub-flavoured markdown as data
throughout, and explicitly forbid the use of MDX and similar technologies in
this repository.

## Requirements

- Node 24+
- Yarn
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
[`deploy.yml`](.github/workflows/deploy.yml). It runs daily on cron, on manual
dispatch, and on pushes to `main`.
