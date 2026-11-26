| Auto-publish deactivates after 60 days of inactivity. Last bumped: 2026-11-19 |
| ----------------------------------------------------------------------------- |

# rfcs.graphql.org

Project issues, pull requests, and discussions enter the tracker when they carry
an explicit `RFC` label or an RFC stage label such as `💡 Proposal (RFC 1)`.
The core GraphQL WG also retains its historical Ideas discussions and RFC documents.
It covers the main GraphQL specification and working group, GraphQL over HTTP,
AI WG, Composite Schemas WG, Federation Spec, GraphiQL, GraphQL.js and its WG,
Golden Path, and GAPs. Source documents supplement proposal histories. Meetings
link to proposals independently of discovery.

For the core WG, sync reads the working tree at `~/Dev/graphql/graphql-wg` when
available, including locally annotated notes. Otherwise it uses its managed
checkout. Paired markers such as `<!--BEGIN[graphql/graphql-spec#1211]-->` and
`<!--END[graphql/graphql-spec#1211]-->` identify passages for a tracked RFC.

Core spec PRs use bare numeric routes such as `/rfcs/42/`. Other projects use
their repository alias, such as `/rfcs/js-42/` or `/rfcs/jswg-42/`.
The RFC index and activity feed group repositories by working group. GraphQL.js
and its WG share one filter, as do Composite Schemas WG and Federation Spec.

## Repo setup

This repo does two separate jobs:

1. `yarn sync-rfcs`
   Fetches RFC-related data from GitHub and from local project and meeting checkouts, then writes plain markdown and JSON into `generated/`.

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

## Local preview

Run `yarn build-site && yarn serve`, then open <http://127.0.0.1:8000>.
`yarn serve` uses Python 3's built-in HTTP server to serve `dist/`.

## Output

- `generated/site.json`
- `generated/rfcs/*.md`
- `dist/**/*.html`

## Deployment

GitHub Pages deployment is configured in
[`deploy.yml`](.github/workflows/deploy.yml). It runs daily on cron, on manual
dispatch, and on pushes to `main`.
