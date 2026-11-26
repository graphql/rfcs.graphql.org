import type { Nodes, Root } from "mdast";
import { meetingDetails } from "./meeting-details.ts";
import { projectFilters, projectName } from "../lib/projects.ts";
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
  stageWeight,
  summarizeEvent,
} from "../lib/format.ts";
import {
  groupIds,
  groupName,
  meetingHref,
  meetingStatus,
} from "../lib/meetings.ts";
import type {
  Meeting,
  MeetingSource,
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

  const today = data.generatedAt.slice(0, 10);
  data.meetings = (data.meetings ?? []).filter((meeting) => {
    if (meeting.cancelled || meeting.date >= today) return false;
    const details = meetingDetails(meeting);
    return (details.attendees ?? 0) >= 2 && details.topics > 0;
  });
  const meetingUrls = new Set(data.meetings.map(meetingHref));
  const visibleEvent = (event: Event) =>
    (event.type !== "wgAgenda" && event.type !== "wgNotes") ||
    meetingUrls.has(event.href.split("#")[0]);
  data.activity = data.activity.filter((entry) => visibleEvent(entry.event));
  for (const rfc of data.rfcs) rfc.events = rfc.events.filter(visibleEvent);

  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });
  await copyPublicDir();

  await writePage(path.join(DIST_DIR, "index.html"), <HomePage data={data} />, {
    title: "GraphQL RFC Tracker",
    description: `Tracks ${data.totalCount} GraphQL RFCs across the spec and working group repos.`,
    pathname: "/",
  });

  const projectPages = projectFilters.map((project) => {
    const rfcs = data.rfcs.filter(
      (rfc) => projectName(rfc.identifier) === project.name,
    );
    const identifiers = new Set(rfcs.map((rfc) => rfc.identifier));
    const subset = {
      ...data,
      rfcs,
      totalCount: rfcs.length,
      activity: data.activity.filter((entry) =>
        identifiers.has(entry.identifier),
      ),
      meetings: data.meetings?.filter(
        (meeting) =>
          meeting.group === project.meetingGroup ||
          meeting.references.some((ref) => identifiers.has(ref.identifier)),
      ),
    };
    return { project, subset };
  });
  const availableSpecs = specFilters.filter((spec) =>
    projectPages.some(
      ({ project, subset }) =>
        project.alias === spec.alias && subset.rfcs.length > 0,
    ),
  );
  const activeProjects = projectPages
    .filter(({ subset }) => subset.activity.length || subset.meetings?.length)
    .map(({ project }) => project);

  await writePage(
    path.join(DIST_DIR, "rfcs", "index.html"),
    <AllRfcsPage filters={availableSpecs} data={data} />,
    {
      title: "All GraphQL RFCs",
      description:
        "Complete listing of tracked GraphQL RFCs across all stages.",
      pathname: "/rfcs/",
    },
  );

  await writePage(
    path.join(DIST_DIR, "activity", "index.html"),
    <ActivityPage filters={activeProjects} data={data} />,
    {
      title: "GraphQL RFC Activity",
      description: "Chronological activity across tracked GraphQL RFCs.",
      pathname: "/activity/",
    },
  );

  for (const { project, subset } of projectPages) {
    for (const section of ["rfcs", "activity"] as const) {
      const pathname = `/${section}/projects/${project.alias}/`;
      // Keep previously published repository filter URLs pointing at the shared view.
      const aliases = new Set([
        project.alias,
        ...project.sources.map((source) => source.alias),
      ]);
      for (const alias of aliases)
        await writePage(
          path.join(DIST_DIR, section, "projects", alias, "index.html"),
          section === "rfcs" ? (
            <AllRfcsPage
              filters={availableSpecs}
              data={subset}
              project={project}
            />
          ) : (
            <ActivityPage
              filters={activeProjects}
              data={subset}
              project={project}
            />
          ),
          {
            pathname,
            title: project.name + " " + section,
            description: "Tracked proposals for " + project.name,
          },
        );
    }
  }

  await writeMeetings(data.meetings, today);

  await Promise.all(
    data.rfcs.map(async (summary) => {
      const markdownPath = path.join(
        ROOT,
        assertSafeFilesystemPath(summary.markdownPath),
      );
      const source = await fs.readFile(markdownPath, "utf8");
      const parsed = matter(source);
      const frontmatter = parsed.data as RfcFrontmatter;
      frontmatter.events = frontmatter.events.filter(visibleEvent);
      await writePage(
        path.join(
          DIST_DIR,
          "rfcs",
          assertSafeFilesystemComponent(summary.identifier),
          "index.html",
        ),
        <RfcPage
          body={parsed.content}
          frontmatter={frontmatter}
          meetings={data.meetings ?? []}
        />,
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
              <span className="brand-mark">GraphQL</span>{" "}
              <span className="brand-copy">RFC Tracker</span>
            </a>
            <nav className="site-nav">
              <a href="/rfcs/">All RFCs</a>
              <a href="/activity/">Activity</a>
              <a href="/meetings/">Meetings</a>
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

function MobileRfcList({ rfcs }: { rfcs: SiteData["rfcs"] }) {
  return (
    <div className="mobile-rfcs">
      {rfcs.length ? (
        <ul>
          {rfcs.map((rfc) => (
            <li key={rfc.identifier}>
              <a className="mobile-rfc-title" href={`/rfcs/${rfc.identifier}/`}>
                {rfc.title} <span>{formatIdentifier(rfc.identifier)}</span>
              </a>
              <div className="mobile-rfc-meta">
                {projectName(rfc.identifier)} · {stageLabel(rfc.stage)}
                {rfc.nextStage && <span className="badge">Next stage</span>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>No tracked RFCs for this project.</p>
      )}
    </div>
  );
}

function HomePage({ data }: { data: SiteData }) {
  const openRfcs = data.rfcs
    .filter((rfc) => !rfc.mergedAt && !rfc.closedAt)
    .sort(compareRfcListEntries);

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
          Follow GraphQL RFCs from proposal through working-group discussion and
          review.
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
        <MobileRfcList rfcs={openRfcs} />
        <div className="table-wrap desktop-rfcs">
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
                  <td>{latestSummary(rfc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Layout>
  );
}

function MeetingActivityCard({ meeting }: { meeting: Meeting }) {
  const details = meetingDetails(meeting);
  const href = meetingHref(meeting);
  const note = meeting.notes[0];
  const stats: string[] = [];
  if (!meeting.cancelled) {
    if (details.attendees !== undefined)
      stats.push(
        `${details.attendees} ${details.confirmed ? "attendee" : "listed attendee"}${details.attendees === 1 ? "" : "s"}`,
      );
    const topics = meeting.agendaSummary?.length ?? details.topics;
    if (topics)
      stats.push(`${topics} agenda ${topics === 1 ? "item" : "items"}`);
    if (meeting.references.length)
      stats.push(
        `${meeting.references.length} linked RFC${meeting.references.length === 1 ? "" : "s"}`,
      );
  }
  return (
    <li
      className={
        details.videoId
          ? "meeting-activity meeting-activity-video"
          : "meeting-activity"
      }
    >
      <div>
        <div className="meeting-activity-heading">
          <strong>
            <a href={href}>{groupName(meeting.group)} meeting</a>
          </strong>
          <time dateTime={meeting.date}>{meeting.date}</time>
        </div>
        {stats.length > 0 && <p>{stats.join(" · ")}</p>}
        {!!meeting.agendaSummary?.length && (
          <ul className="meeting-agenda-summary" aria-label="Agenda summary">
            {meeting.agendaSummary.map(({ text, identifiers }, index) => (
              <li key={index}>
                {text}
                {identifiers.map((identifier) => (
                  <React.Fragment key={identifier}>
                    {" "}
                    <a href={`/rfcs/${identifier}/`}>
                      {formatIdentifier(identifier)}
                    </a>
                  </React.Fragment>
                ))}
              </li>
            ))}
          </ul>
        )}
        <div className="meeting-activity-links">
          {meeting.cancelled && <strong>Cancelled</strong>}
          <a href={meeting.agenda.href}>Agenda</a>
          {note ? (
            <a href={note.section ? href + "#" + note.section : note.href}>
              Notes
            </a>
          ) : (
            !meeting.cancelled && <span>Notes pending</span>
          )}
          {details.video && <a href={details.video}>Video recording</a>}
        </div>
      </div>
      {details.videoId && (
        <iframe
          src={"https://www.youtube-nocookie.com/embed/" + details.videoId}
          loading="lazy"
          title={
            groupName(meeting.group) + " meeting recording, " + meeting.date
          }
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      )}
    </li>
  );
}

function FilterLinks({
  label,
  links,
  current,
}: {
  label: string;
  links: { href: string; name: string }[];
  current: string;
}) {
  return (
    <nav className="filter-links" aria-label={label}>
      {links.map(({ href, name }) => (
        <a
          key={href}
          href={href}
          aria-current={current === href ? "page" : undefined}
        >
          {name}
        </a>
      ))}
    </nav>
  );
}

function orderedMeetingGroups(meetings: Meeting[], today: string) {
  const pinned = [
    "graphql-wg",
    "graphql-over-http",
    "composite-schemas-wg",
    "ai-wg",
  ] as const;
  // Clamp month-end dates to the last day of the target calendar month.
  const date = new Date(today + "T00:00:00Z");
  const cutoff = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 5, 0),
  );
  cutoff.setUTCDate(Math.min(date.getUTCDate(), cutoff.getUTCDate()));
  const since = cutoff.toISOString().slice(0, 10);
  const remaining = groupIds
    .filter((group) => !pinned.some((id) => id === group))
    .map((group) => {
      const held = meetings.filter((meeting) => meeting.group === group);
      return {
        group,
        recent: held.some((meeting) => meeting.date >= since),
        count: held.length,
      };
    });
  remaining.sort(
    (a, b) =>
      Number(b.recent) - Number(a.recent) ||
      b.count - a.count ||
      groupName(a.group).localeCompare(groupName(b.group)),
  );
  return [...pinned, ...remaining.map((entry) => entry.group)];
}

async function writeMeetings(meetings: Meeting[], today: string) {
  const write = (pathname: string, title: string, body: React.ReactNode) => {
    const meta = { pathname, title, description: title };
    return writePage(
      path.join(
        DIST_DIR,
        assertSafeFilesystemPath(pathname.slice(1, -1)),
        "index.html",
      ),
      <Layout {...meta}>{body}</Layout>,
      meta,
    );
  };
  const links = [
    { href: "/meetings/", name: "All groups" },
    ...orderedMeetingGroups(meetings, today)
      .filter((group) => meetings.some((meeting) => meeting.group === group))
      .map((group) => ({
        href: `/meetings/${group}/`,
        name: groupName(group),
      })),
  ];
  const archive = (pathname: string, title: string, entries: Meeting[]) => {
    const months = new Map<string, Meeting[]>();
    for (const meeting of [...entries].reverse()) {
      const key = meeting.date.slice(0, 7);
      const month = months.get(key) ?? [];
      month.push(meeting);
      months.set(key, month);
    }
    return write(
      pathname,
      title,
      <section className="section-block">
        <h1>{title}</h1>
        <FilterLinks
          label="Filter by working group"
          current={pathname}
          links={links}
        />
        {[...months].map(([month, items]) => (
          <section className="activity-month" key={month}>
            <h2 className="activity-month-divider">
              <span>{formatMonthLabel(month)}</span>
            </h2>
            <ul className="activity-list">
              {items.map((meeting) => (
                <MeetingActivityCard
                  meeting={meeting}
                  key={meetingHref(meeting)}
                />
              ))}
            </ul>
          </section>
        ))}
        {!months.size && <p>No meetings to display.</p>}
      </section>,
    );
  };
  await archive("/meetings/", "Working group meetings", meetings);
  for (const group of groupIds) {
    const groupHref = `/meetings/${group}/`;
    const series = meetings.filter((meeting) => meeting.group === group);
    await archive(groupHref, groupName(group) + " meetings", series);
    for (const meeting of series) {
      const neighbors = [
        ["Previous in series", series, -1],
        ["Previous", meetings, -1],
        ["Next", meetings, 1],
        ["Next in series", series, 1],
      ] as const;
      const navigation = (
        <nav className="meeting-navigation" aria-label="Meeting navigation">
          {neighbors.map(([label, entries, offset]) => {
            const target = entries[entries.indexOf(meeting) + offset];
            return target ? (
              <a
                key={label}
                href={meetingHref(target)}
                title={groupName(target.group) + " · " + target.date}
              >
                {label}
              </a>
            ) : (
              <span key={label} aria-disabled="true">
                {label}
              </span>
            );
          })}
        </nav>
      );
      const title = groupName(group) + " · " + meeting.date;
      await write(
        meetingHref(meeting),
        title,
        <>
          <header className="section-block">
            <h1>{title}</h1>
            <a href={groupHref}>{groupName(group)} meetings</a> ·{" "}
            {meetingStatus(meeting)}
          </header>
          {navigation}
          <MeetingDocument source={meeting.agenda} title="Agenda" />
          {navigation}
          {meeting.notes.length ? (
            meeting.notes.map((note, index) => (
              <MeetingDocument
                key={note.section}
                source={note}
                title={
                  note.href.includes("/summary-")
                    ? "Zoom summary"
                    : index === 0
                      ? "Notes"
                      : "Additional notes"
                }
              />
            ))
          ) : (
            <section className="section-block">
              <h2>Notes</h2>
              <p>Notes pending</p>
            </section>
          )}
          {navigation}
          {meeting.references.length > 0 && (
            <section className="section-block">
              <h2>Tracked RFCs</h2>
              <ul className="link-list">
                {meeting.references.map(({ identifier, section }) => (
                  <li key={identifier}>
                    <a href={`/rfcs/${assertSafeURLComponent(identifier)}/`}>
                      {formatIdentifier(identifier)}
                    </a>
                    {" · "}
                    {section ? (
                      <a href={`#${section}`}>Discussed</a>
                    ) : (
                      "On the agenda"
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>,
      );
    }
  }
}

function MeetingDocument({
  source,
  title,
}: {
  source: MeetingSource;
  title: string;
}) {
  return (
    <section className="section-block markdown-body" id={source.section}>
      <h2>{title}</h2>
      <p>
        <a href={source.href}>View {title.toLowerCase()} on GitHub</a>
      </p>
      <Markdown
        content={source.content}
        source={source}
        agenda={title === "Agenda"}
      />
    </section>
  );
}

function RfcMeetings({
  meetings,
  identifier,
}: {
  meetings: Meeting[];
  identifier: string;
}) {
  const entries = meetings
    .flatMap((meeting) => {
      const reference = meeting.references.find(
        (ref) => ref.identifier === identifier,
      );
      return reference ? [{ meeting, section: reference.section }] : [];
    })
    .reverse();
  if (!entries.length) return null;
  return (
    <section className="detail-timeline">
      <h2>Working group meetings</h2>
      <ul className="detail-timeline-list">
        {entries.map(({ meeting, section }) => (
          <li key={meetingHref(meeting)}>
            <a href={meetingHref(meeting) + (section ? `#${section}` : "")}>
              {groupName(meeting.group)} · {meeting.date}
            </a>
            {" · "}
            {section ? "Discussed" : "On the agenda"}
            {meeting.cancelled && " · Cancelled"}
          </li>
        ))}
      </ul>
    </section>
  );
}

const specFilters = [
  { alias: "graphql", name: "GraphQL Spec" },
  { alias: "http", name: "GraphQL over HTTP Spec" },
  { alias: "compwg", name: "Federation Spec" },
];

type ProjectFilter = { alias: string; name: string };

function ProjectLinks({
  section,
  alias,
  filters,
}: {
  section: string;
  alias?: string;
  filters: ProjectFilter[];
}) {
  const base = "/" + section + "/";
  return (
    <FilterLinks
      label="Filter by project"
      links={[
        { href: base, name: section === "rfcs" ? "All RFCs" : "All projects" },
        ...filters.map((project) => ({
          name: project.name,
          href: base + "projects/" + project.alias + "/",
        })),
      ]}
      current={alias ? base + "projects/" + alias + "/" : base}
    />
  );
}

function ActivityPage({
  data,
  project,
  filters,
}: {
  data: SiteData;
  project?: ProjectFilter;
  filters: ProjectFilter[];
}) {
  const meetings = data.meetings ?? [];
  const activityGroups = groupActivityByMonth(data.activity);
  const monthKeys = [
    ...new Set([
      ...activityGroups.map((month) => month.key),
      ...meetings.map((meeting) => meeting.date.slice(0, 7)),
    ]),
  ]
    .sort()
    .reverse();

  return (
    <Layout
      title="GraphQL RFC Activity"
      description="Chronological activity across tracked GraphQL RFCs."
      pathname={project ? `/activity/projects/${project.alias}/` : "/activity/"}
    >
      <section className="hero hero-compact">
        <p className="eyebrow">Cross-repo timeline</p>
        <h1>{project ? project.name + " · " : ""}Recent activity</h1>
        <ProjectLinks
          filters={filters}
          section="activity"
          alias={project?.alias}
        />
        <p className="lede">
          Proposal activity across GitHub issues, pull requests, discussions,
          documents, and working group meetings.
        </p>
      </section>
      <section className="section-block">
        <div className="activity-groups">
          {monthKeys.map((key) => {
            const month = activityGroups.find((group) => group.key === key);
            const cards = [
              ...meetings
                .filter((meeting) => meeting.date.startsWith(key))
                .map((meeting) => ({
                  date: meeting.date,
                  element: (
                    <MeetingActivityCard
                      key={meetingHref(meeting)}
                      meeting={meeting}
                    />
                  ),
                })),
              ...(month?.rfcs ?? []).map((rfc) => ({
                date: rfc.events[0].date,
                element: (
                  <li key={rfc.identifier}>
                    <article className="activity-card">
                      <div className="activity-card-top">
                        <a href={`/rfcs/${rfc.identifier}/`}>
                          {formatIdentifier(rfc.identifier)} {rfc.title}
                        </a>
                        <span>{stageLabel(rfc.stage)}</span>
                      </div>
                      <ul className="activity-events">
                        {rfc.events.map((event, index) => (
                          <li key={`${event.type}:${event.date}:${index}`}>
                            {renderActivityEvent(event)}
                          </li>
                        ))}
                      </ul>
                    </article>
                  </li>
                ),
              })),
            ].sort((a, b) => b.date.localeCompare(a.date));
            return (
              <section className="activity-month" key={key}>
                <div className="activity-month-divider">
                  <span>{formatMonthLabel(key)}</span>
                </div>
                <ul className="activity-list">
                  {cards.map(({ element }) => element)}
                </ul>
              </section>
            );
          })}
        </div>
      </section>
    </Layout>
  );
}

function AllRfcsPage({
  data,
  project,
  filters,
}: {
  data: SiteData;
  project?: ProjectFilter;
  filters: ProjectFilter[];
}) {
  const allRfcs = [...data.rfcs].sort(compareRfcListEntries);

  const spec = specFilters.find((filter) => filter.alias === project?.alias);
  const title = project ? (spec?.name ?? project.name) + " RFCs" : "All RFCs";
  return (
    <Layout
      title={title}
      description="Tracked GraphQL RFCs across all stages."
      pathname={project ? `/rfcs/projects/${project.alias}/` : "/rfcs/"}
    >
      <section className="section-block">
        <div className="section-head">
          <h1>{title}</h1>
          <a href="/">View open RFCs</a>
        </div>
        <ProjectLinks filters={filters} section="rfcs" alias={project?.alias} />
        <MobileRfcList rfcs={allRfcs} />
        <div className="table-wrap desktop-rfcs">
          <table className="rfc-table">
            <thead>
              <tr>
                <th>RFC</th>
                <th>Project</th>
                <th>Stage</th>
                <th>Champion</th>
                <th>Title</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {!allRfcs.length && (
                <tr>
                  <td colSpan={6}>No tracked RFCs for this project.</td>
                </tr>
              )}
              {allRfcs.map((rfc) => (
                <tr key={rfc.identifier}>
                  <td>
                    <a href={`/rfcs/${rfc.identifier}/`}>
                      {formatIdentifier(rfc.identifier)}
                    </a>
                    {rfc.nextStage ? (
                      <span className="badge">Next stage</span>
                    ) : null}
                  </td>
                  <td>{projectName(rfc.identifier)}</td>
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
                  <td>{latestSummary(rfc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Layout>
  );
}

function RfcPage(props: {
  frontmatter: RfcFrontmatter;
  meetings: Meeting[];
  body: string;
}) {
  const { frontmatter, body, meetings } = props;
  const openedOn = getOpenedOn(frontmatter.events);
  const secondaryDate = getSecondaryDate(frontmatter);
  const contentBody = stripGeneratedTimeline(stripLeadingTitle(body));
  const timelineMonths = groupEventsByMonth(frontmatter.events);

  return (
    <Layout
      title={`${frontmatter.title} | GraphQL RFC Tracker`}
      description={frontmatter.description}
      pathname={`/rfcs/${frontmatter.identifier}/`}
    >
      <section className="hero hero-compact">
        <p className="eyebrow">{stageLabel(frontmatter.stage)}</p>
        <h1>{frontmatter.title}</h1>
        <div className="hero-meta">
          <div>
            <span className="meta-label">Opened on</span>
            <strong>{openedOn}</strong>
          </div>
          <div>
            <span className="meta-label">{secondaryDate.label}</span>
            <strong>{secondaryDate.value}</strong>
          </div>
        </div>
      </section>

      <section className="section-grid">
        <aside className="summary-card">
          <h2>Summary</h2>
          <dl className="meta-grid">
            <dt>Project</dt>
            <dd>{projectName(frontmatter.identifier)}</dd>
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
            {frontmatter.issueUrl && (
              <li>
                <a href={frontmatter.issueUrl}>Issue</a>
              </li>
            )}
            {frontmatter.prUrl ? (
              <li>
                <a href={frontmatter.prUrl}>Pull request</a>
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
          <Markdown content={contentBody} />
          <RfcMeetings
            meetings={meetings}
            identifier={frontmatter.identifier}
          />
          <section className="detail-timeline">
            <h2>Timeline</h2>
            <div className="activity-groups detail-timeline-groups">
              {timelineMonths.map((month) => (
                <section className="activity-month" key={month.label}>
                  <div className="activity-month-divider">
                    <span>{month.label}</span>
                  </div>
                  <ul className="detail-timeline-list">
                    {month.events.map((event, index) => (
                      <li
                        key={`${month.label}:${event.type}:${event.date}:${index}`}
                      >
                        {renderActivityEvent(event)}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </section>
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

function hideMarkdownComments(node: Nodes) {
  if (node.type === "html")
    node.value = node.value.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  else if ("children" in node) node.children.forEach(hideMarkdownComments);
}

function Markdown({
  content,
  source,
  agenda,
}: {
  content: string;
  source?: MeetingSource;
  agenda?: boolean;
}) {
  const resolve = (url: string | undefined, image = false) => {
    if (
      !source ||
      !url ||
      url.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(url) ||
      url.startsWith("//")
    )
      return normalizeHref(url);
    const base = new URL(source.href);
    const repo = base.pathname.split("/").slice(0, 5).join("/");
    const resolved = url.startsWith("/")
      ? new URL(repo + url, base)
      : new URL(url, base);
    if (image) resolved.pathname = resolved.pathname.replace("/blob/", "/raw/");
    return resolved.href;
  };
  const headingComponent =
    (tag: `h${1 | 2 | 3 | 4 | 5 | 6}`) =>
    ({
      children,
      node,
    }: React.PropsWithChildren<{
      node?: { position?: { start: { line: number } } };
    }>) =>
      React.createElement(
        tag,
        {
          id:
            source?.section && node?.position
              ? `${source.section}-${node.position.start.line}`
              : undefined,
        },
        children,
      );
  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        () => (tree: Root) => {
          hideMarkdownComments(tree);
          if (agenda) {
            const first = tree.children.findIndex(
              (node) => node.type === "heading" && node.depth === 1,
            );
            if (first > 0)
              tree.children = tree.children.filter(
                (node, index) => index >= first || node.type === "definition",
              );
          }
        },
      ]}
      components={{
        ...(source && {
          h1: headingComponent("h1"),
          h2: headingComponent("h2"),
          h3: headingComponent("h3"),
          h4: headingComponent("h4"),
          h5: headingComponent("h5"),
          h6: headingComponent("h6"),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
          img: ({ src, alt }) => <img src={resolve(src, true)} alt={alt} />,
        }),
        a: ({ href, children, node: _node, ...props }) => (
          <a href={resolve(href)} {...props}>
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

function stripGeneratedTimeline(content: string): string {
  return content.replace(/\n## Timeline[\s\S]*$/m, "").trimEnd();
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
    case "issueCreated":
    case "issueClosed":
      return <a href={event.href}>{summarizeEvent(event)}</a>;
    case "prCreated":
      return (
        <>
          <a href={event.href}>Pull request</a> created on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "prMerged":
      return (
        <>
          <a href={event.href}>Pull request</a> merged on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "prClosed":
      return (
        <>
          <a href={event.href}>Pull request</a> closed on{" "}
          {formatDate(event.date)}
        </>
      );
    case "topCommentEdited":
      return (
        <>
          <a href={event.href}>Top comment</a> edited on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "statusChanged":
      return (
        <>
          <a href={event.href}>{event.summary}</a> on {formatDate(event.date)}
          {event.actor ? ` by ${event.actor}` : ""}
        </>
      );
    case "docCreated":
      return (
        <>
          <a href={event.href}>RFC document</a> created on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "docUpdated":
      return (
        <>
          <a href={event.href}>RFC document</a> updated on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "wgDiscussionCreated":
      return (
        <>
          <a href={event.href}>WG discussion</a> created on{" "}
          {formatDate(event.date)} by {event.actor ?? "unknown"}
        </>
      );
    case "wgAgenda":
      return (
        <>
          Added to{" "}
          <a href={event.href}>
            {event.group ? groupName(event.group) : "WG"} agenda
          </a>{" "}
          on {formatDate(event.date)}
        </>
      );
    case "wgNotes":
      return (
        <>
          Mentioned in{" "}
          <a href={event.href}>
            {event.group ? groupName(event.group) : "WG"} notes
          </a>{" "}
          on {formatDate(event.date)}
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
    const monthLabel = formatDate(entry.event.date).slice(0, 7);
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

  return [...months.entries()].map(([key, days]) => ({
    key,
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

function groupEventsByMonth(events: Event[]) {
  const months = new Map<string, Event[]>();

  for (const event of events) {
    const monthLabel = formatMonthLabel(formatDate(event.date));
    const month = months.get(monthLabel) ?? [];
    month.push(event);
    months.set(monthLabel, month);
  }

  return [...months.entries()].map(([label, monthEvents]) => ({
    label,
    events: [...monthEvents].sort(
      (left, right) => Date.parse(right.date) - Date.parse(left.date),
    ),
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

function getOpenedOn(events: Event[]): string {
  if (events.length === 0) {
    return "-";
  }
  const oldest = [...events].sort(
    (left, right) => Date.parse(left.date) - Date.parse(right.date),
  )[0];
  return formatDate(oldest.date);
}

function getSecondaryDate(frontmatter: RfcFrontmatter): {
  label: "Merged on" | "Closed on" | "Updated on";
  value: string;
} {
  if (frontmatter.mergedAt) {
    return {
      label: "Merged on",
      value: formatDate(frontmatter.mergedAt),
    };
  }
  if (frontmatter.closedAt) {
    return {
      label: "Closed on",
      value: formatDate(frontmatter.closedAt),
    };
  }
  return {
    label: "Updated on",
    value: formatDate(frontmatter.updatedAt),
  };
}

function getLatestActivityTimestamp(rfc: { events: Event[] }): number {
  return getLatestEventTimestamp(rfc);
}

function compareRfcListEntries(
  left: {
    stage: RfcFrontmatter["stage"];
    nextStage?: boolean;
    events: Event[];
  },
  right: {
    stage: RfcFrontmatter["stage"];
    nextStage?: boolean;
    events: Event[];
  },
): number {
  const stageDelta = stageWeight(right.stage) - stageWeight(left.stage);
  if (stageDelta !== 0) {
    return stageDelta;
  }
  const nextStageDelta =
    Number(right.nextStage ?? false) - Number(left.nextStage ?? false);
  if (nextStageDelta !== 0) {
    return nextStageDelta;
  }
  return getLatestEventTimestamp(right) - getLatestEventTimestamp(left);
}

function latestSummary(rfc: { updatedAt: string; events: Event[] }): string {
  const latestEvent = rfc.events[0];
  return latestEvent
    ? summarizeEvent(latestEvent)
    : `Updated on ${formatDate(rfc.updatedAt)}`;
}

function getLatestEventTimestamp(rfc: { events: Event[] }): number {
  const latestEvent = rfc.events[0]?.date;
  return latestEvent ? Date.parse(latestEvent) : Number.NEGATIVE_INFINITY;
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
