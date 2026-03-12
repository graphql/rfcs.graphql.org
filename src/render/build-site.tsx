import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  formatDate,
  formatIdentifier,
  stageLabel,
  summarizeEvent,
} from "../lib/format.ts";
import type {
  ActivityEntry,
  Event,
  RfcFrontmatter,
  SiteData,
} from "../lib/types.ts";

const ROOT = process.cwd();
const GENERATED_DIR = path.join(ROOT, "generated");
const DIST_DIR = path.join(ROOT, "dist");
const PUBLIC_DIR = path.join(ROOT, "public");

function assertSafeFilesystemComponent(str: string): string {
  if (str === "." || str.startsWith("..")) {
    throw new Error(`Unsafe filesystem component: ${JSON.stringify(str)}`);
  }
  if (!/^[-_.a-zA-Z0-9]+$/.test(str)) {
    throw new Error(`Unsafe filesystem component: ${JSON.stringify(str)}`);
  }
  return str;
}

function assertSafeFilesystemPath(str: string): string {
  const parts = str.split("/");
  if (parts.length === 0)
    throw new Error(`Invalid path component: empty string`);
  parts.forEach(assertSafeFilesystemComponent);
  return str;
}

function assertSafeURLComponent(str: string): string {
  return assertSafeFilesystemComponent(str);
}

function assertSafeURLPath(str: string): string {
  const parts = str.split("/");
  if (parts.length === 0)
    throw new Error(`Invalid path component: empty string`);
  parts.forEach(assertSafeURLComponent);
  return str;
}

async function main(): Promise<void> {
  const data = JSON.parse(
    await fs.readFile(path.join(GENERATED_DIR, "site.json"), "utf8"),
  ) as SiteData;

  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });
  await copyPublicDir();

  await writePage(path.join(DIST_DIR, "index.html"), <HomePage data={data} />, {
    title: "GraphQL RFC Tracker",
    description: `Tracks ${data.totalCount} GraphQL RFCs across the spec and working group repos.`,
    pathname: "/",
  });

  await writePage(
    path.join(DIST_DIR, "rfcs", "index.html"),
    <AllRfcsPage data={data} />,
    {
      title: "All GraphQL RFCs",
      description:
        "Complete listing of tracked GraphQL RFCs across all stages.",
      pathname: "/rfcs/",
    },
  );

  await writePage(
    path.join(DIST_DIR, "activity", "index.html"),
    <ActivityPage data={data} />,
    {
      title: "GraphQL RFC Activity",
      description: "Chronological activity across tracked GraphQL RFCs.",
      pathname: "/activity/",
    },
  );

  await Promise.all(
    data.rfcs.map(async (summary) => {
      const markdownPath = path.join(
        ROOT,
        assertSafeFilesystemPath(summary.markdownPath),
      );
      const source = await fs.readFile(markdownPath, "utf8");
      const parsed = matter(source);
      const frontmatter = parsed.data as RfcFrontmatter;
      await writePage(
        path.join(
          DIST_DIR,
          "rfcs",
          assertSafeFilesystemComponent(summary.identifier),
          "index.html",
        ),
        <RfcPage body={parsed.content} frontmatter={frontmatter} />,
        {
          title: `${summary.title} | GraphQL RFC Tracker`,
          description: summary.description,
          pathname: `/rfcs/${assertSafeURLComponent(summary.identifier)}/`,
        },
      );
    }),
  );

  await writePage(path.join(DIST_DIR, "404.html"), <NotFoundPage />, {
    title: "Not found | GraphQL RFC Tracker",
    description: "The requested RFC page does not exist.",
    pathname: "/404.html",
  });
}

function Layout(props: {
  children: React.ReactNode;
  title: string;
  description: string;
  pathname: string;
}) {
  if (!props.pathname.startsWith("/")) {
    throw new Error(`pathname must start with "/"!`);
  }
  const canonicalUrl = `https://rfcs.graphql.org${props.pathname}`;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta name="description" content={props.description} />
        <link rel="canonical" href={canonicalUrl} />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <div className="page-shell">
          <header className="site-header">
            <a className="brand" href="/">
              <span className="brand-mark">GraphQL</span>
              <span className="brand-copy">RFC Tracker</span>
            </a>
            <nav className="site-nav">
              <a href="/rfcs/">All RFCs</a>
              <a href="/activity/">Activity</a>
              <a href="https://github.com/graphql/graphql-spec">graphql-spec</a>
              <a href="https://github.com/graphql/graphql-wg">graphql-wg</a>
            </nav>
          </header>
          <main>{props.children}</main>
          <footer className="site-footer">
            <p>Copyright &copy; GraphQL Contributors</p>
          </footer>
        </div>
      </body>
    </html>
  );
}

function HomePage({ data }: { data: SiteData }) {
  const openRfcs = data.rfcs.filter((rfc) => !rfc.mergedAt && !rfc.closedAt);

  return (
    <Layout
      title="GraphQL RFC Tracker"
      description={`Tracks ${data.totalCount} GraphQL RFCs across the spec and working group repos.`}
      pathname="/"
    >
      <section className="hero">
        <p className="eyebrow">rfcs.graphql.org</p>
        <h1>GraphQL RFC Tracker</h1>
        <p className="lede">
          Tracks commits, commentary, and stages. Interlinks based on
          heuristics. Also fetches details of GraphQL Spec WG meetings to
          determine when each RFC has been discussed, to allow looking up
          discussions in the recordings.
        </p>
        <p>
          Not the canonical source of information &mdash; please see the RFCs
          themselves! This content is autogenerated based on heuristics.
        </p>
        <div className="hero-meta">
          <div>
            <span className="meta-label">RFCs tracked</span>
            <strong>{data.totalCount}</strong>
          </div>
          <div>
            <span className="meta-label">Last generated</span>
            <strong>{formatDate(data.generatedAt)}</strong>
          </div>
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2>Open RFCs</h2>
          <a href="/activity/">View activity</a>
        </div>
        <div className="table-wrap">
          <table className="rfc-table">
            <thead>
              <tr>
                <th>RFC</th>
                <th>Stage</th>
                <th>Champion</th>
                <th>Title</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {openRfcs.map((rfc) => (
                <tr key={rfc.identifier}>
                  <td>
                    <a href={`/rfcs/${rfc.identifier}/`}>
                      {formatIdentifier(rfc.identifier)}
                    </a>
                    {rfc.nextStage ? (
                      <span className="badge">Next stage</span>
                    ) : null}
                  </td>
                  <td>{stageLabel(rfc.stage)}</td>
                  <td>
                    {rfc.champion ? (
                      <a href={`https://github.com/${rfc.champion}`}>
                        @{rfc.champion}
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <a href={`/rfcs/${rfc.identifier}/`}>{rfc.title}</a>
                  </td>
                  <td>{summarizeEvent(rfc.events[0])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Layout>
  );
}

function ActivityPage({ data }: { data: SiteData }) {
  const activityGroups = groupActivityByMonth(data.activity);

  return (
    <Layout
      title="GraphQL RFC Activity"
      description="Chronological activity across tracked GraphQL RFCs."
      pathname="/activity/"
    >
      <section className="hero hero-compact">
        <p className="eyebrow">Cross-repo timeline</p>
        <h1>Recent activity</h1>
        <p className="lede">
          A merged activity feed for spec PRs, RFC document history, and working
          group mentions.
        </p>
      </section>
      <section className="section-block">
        <div className="activity-groups">
          {activityGroups.map((month) => (
            <section className="activity-month" key={month.label}>
              <div className="activity-month-divider">
                <span>{month.label}</span>
              </div>
              <ol className="activity-list">
                {month.rfcs.map((rfc) => (
                  <li key={`${month.label}:${rfc.identifier}`}>
                    <article className="activity-card">
                      <div className="activity-card-top">
                        <a href={`/rfcs/${rfc.identifier}/`}>
                          {formatIdentifier(rfc.identifier)} {rfc.title}
                        </a>
                        <span>{stageLabel(rfc.stage)}</span>
                      </div>
                      <ul className="activity-events">
                        {rfc.events.map((event, index) => (
                          <li
                            key={`${rfc.identifier}:${event.type}:${event.date}:${index}`}
                          >
                            {renderActivityEvent(event)}
                          </li>
                        ))}
                      </ul>
                    </article>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </section>
    </Layout>
  );
}

function AllRfcsPage({ data }: { data: SiteData }) {
  return (
    <Layout
      title="All GraphQL RFCs"
      description="Complete listing of tracked GraphQL RFCs across all stages."
      pathname="/rfcs/"
    >
      <section className="hero hero-compact">
        <p className="eyebrow">Complete index</p>
        <h1>All RFCs</h1>
        <p className="lede">
          Full tracker view including open, merged, rejected, and superseded
          RFCs.
        </p>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2>All RFCs</h2>
          <a href="/">View open RFCs</a>
        </div>
        <div className="table-wrap">
          <table className="rfc-table">
            <thead>
              <tr>
                <th>RFC</th>
                <th>Stage</th>
                <th>Champion</th>
                <th>Title</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {data.rfcs.map((rfc) => (
                <tr key={rfc.identifier}>
                  <td>
                    <a href={`/rfcs/${rfc.identifier}/`}>
                      {formatIdentifier(rfc.identifier)}
                    </a>
                    {rfc.nextStage ? (
                      <span className="badge">Next stage</span>
                    ) : null}
                  </td>
                  <td>{stageLabel(rfc.stage)}</td>
                  <td>
                    {rfc.champion ? (
                      <a href={`https://github.com/${rfc.champion}`}>
                        @{rfc.champion}
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <a href={`/rfcs/${rfc.identifier}/`}>{rfc.title}</a>
                  </td>
                  <td>{summarizeEvent(rfc.events[0])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Layout>
  );
}

function RfcPage(props: { frontmatter: RfcFrontmatter; body: string }) {
  const { frontmatter, body } = props;
  return (
    <Layout
      title={`${frontmatter.title} | GraphQL RFC Tracker`}
      description={frontmatter.description}
      pathname={`/rfcs/${frontmatter.identifier}/`}
    >
      <section className="hero hero-compact">
        <p className="eyebrow">{stageLabel(frontmatter.stage)}</p>
        <h1>{frontmatter.title}</h1>
        <p className="lede">{frontmatter.description}</p>
      </section>

      <section className="section-grid">
        <aside className="summary-card">
          <h2>Summary</h2>
          <dl className="meta-grid">
            <dt>Identifier</dt>
            <dd>{formatIdentifier(frontmatter.identifier)}</dd>
            <dt>Stage</dt>
            <dd>{stageLabel(frontmatter.stage)}</dd>
            <dt>Champion</dt>
            <dd>
              {frontmatter.champion ? (
                <a href={`https://github.com/${frontmatter.champion}`}>
                  @{frontmatter.champion}
                </a>
              ) : (
                "-"
              )}
            </dd>
            <dt>Updated</dt>
            <dd>{formatDate(frontmatter.updatedAt)}</dd>
          </dl>
          <ul className="link-list">
            {frontmatter.prUrl ? (
              <li>
                <a href={frontmatter.prUrl}>Spec PR</a>
              </li>
            ) : null}
            {frontmatter.rfcDocUrl ? (
              <li>
                <a href={frontmatter.rfcDocUrl}>RFC document</a>
              </li>
            ) : null}
            {frontmatter.wgDiscussionUrl ? (
              <li>
                <a href={frontmatter.wgDiscussionUrl}>WG discussion</a>
              </li>
            ) : null}
          </ul>
          {frontmatter.related && frontmatter.related.length > 0 ? (
            <>
              <h3>Related</h3>
              <ul className="link-list">
                {frontmatter.related.map((related) => (
                  <li key={related}>
                    <a href={`/rfcs/${related}/`}>
                      {formatIdentifier(related)}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>

        <article className="markdown-body">
          <Markdown content={stripLeadingTitle(body)} />
        </article>
      </section>
    </Layout>
  );
}

function NotFoundPage() {
  return (
    <Layout
      title="Not found | GraphQL RFC Tracker"
      description="The requested RFC page does not exist."
      pathname="/404.html"
    >
      <section className="hero hero-compact">
        <p className="eyebrow">404</p>
        <h1>Page not found</h1>
        <p className="lede">
          The requested RFC page does not exist in the generated site output.
        </p>
      </section>
    </Layout>
  );
}

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, node: _node, ...props }) => (
          <a href={normalizeHref(href)} {...props}>
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function normalizeHref(href: string | undefined): string | undefined {
  if (!href) {
    return href;
  }
  if (/^\/rfcs\/[^/]+$/.test(href)) {
    return `${href}/`;
  }
  return href;
}

function stripLeadingTitle(content: string): string {
  return content.replace(/^# [^\n]+\n+/m, "");
}

function eventSentence(event: Event): string {
  if (event.type === "commitsPushed") {
    return `${event.commits.length} commit${event.commits.length === 1 ? "" : "s"} pushed on ${formatDate(event.date)}.`;
  }
  return `${summarizeEvent(event)}.`;
}

function renderActivityEvent(event: Event): React.ReactNode {
  if (event.type === "commitsPushed") {
    if (event.commits.length === 1) {
      const commit = event.commits[0];
      return (
        <>
          {commit.ghUser
            ? `@${commit.ghUser}`
            : (commit.authorName ?? "Someone")}{" "}
          committed "<a href={commit.href}>{commit.headline}</a>" on{" "}
          {formatDate(event.date)}
        </>
      );
    }

    return (
      <>
        <a href={event.href}>{event.commits.length} commits pushed</a> on{" "}
        {formatDate(event.date)}
        <ul className="activity-event-commits">
          {event.commits.map((commit) => (
            <li key={commit.href}>
              {commit.ghUser
                ? `@${commit.ghUser}`
                : (commit.authorName ?? "unknown")}{" "}
              committed "<a href={commit.href}>{commit.headline}</a>"
            </li>
          ))}
        </ul>
      </>
    );
  }

  switch (event.type) {
    case "prCreated":
      return (
        <>
          <a href={event.href}>Spec PR</a> created on {formatDate(event.date)}{" "}
          by {event.actor ?? "unknown"}
        </>
      );
    case "docCreated":
      return (
        <>
          <a href={event.href}>RFC document created</a> on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "docUpdated":
      return (
        <>
          <a href={event.href}>RFC document updated</a> on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "wgDiscussionCreated":
      return (
        <>
          <a href={event.href}>WG discussion created</a> on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "wgAgenda":
      return (
        <>
          Added to <a href={event.href}>WG agenda</a> on{" "}
          {formatDate(event.date)}
        </>
      );
    case "wgNotes":
      return (
        <>
          Mentioned in <a href={event.href}>WG notes</a> on{" "}
          {formatDate(event.date)}
        </>
      );
  }
}

function groupActivityByMonth(activity: ActivityEntry[]) {
  const months = new Map<
    string,
    Map<
      string,
      {
        identifier: string;
        title: string;
        stage: ActivityEntry["stage"];
        events: Event[];
      }
    >
  >();

  for (const entry of activity) {
    const monthLabel = formatMonthLabel(formatDate(entry.event.date));
    const month = months.get(monthLabel) ?? new Map();
    months.set(monthLabel, month);

    const rfc = month.get(entry.identifier) ?? {
      identifier: entry.identifier,
      title: entry.title,
      stage: entry.stage,
      events: [],
    };
    rfc.events.push(entry.event);
    month.set(entry.identifier, rfc);
  }

  return [...months.entries()].map(([label, days]) => ({
    label,
    rfcs: [...days.values()]
      .map((rfc) => ({
        ...rfc,
        events: [...rfc.events].sort(
          (left, right) => Date.parse(right.date) - Date.parse(left.date),
        ),
      }))
      .sort((left, right) => left.identifier.localeCompare(right.identifier)),
  }));
}

function formatMonthLabel(date: string): string {
  const [year, month] = date.split("-");
  const label = new Date(`${year}-${month}-01T00:00:00Z`).toLocaleString(
    "en-GB",
    {
      month: "long",
      timeZone: "UTC",
    },
  );
  return `${label} ${year}`;
}

async function writePage(
  targetPath: string,
  element: React.ReactElement,
  _meta: { title: string; description: string; pathname: string },
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const html = "<!DOCTYPE html>\n" + renderToStaticMarkup(element);
  await fs.writeFile(targetPath, html, "utf8");
}

async function copyPublicDir(): Promise<void> {
  try {
    await fs.access(PUBLIC_DIR);
  } catch {
    return;
  }
  await copyDir(PUBLIC_DIR, DIST_DIR);
}

async function copyDir(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(targetPath, { recursive: true });
        await copyDir(sourcePath, targetPath);
        return;
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
