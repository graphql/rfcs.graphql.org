import { graphql } from "@octokit/graphql";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import YAML from "yaml";
import { projects, projectName } from "../lib/projects.ts";
import { groupIds, meetingHref } from "../lib/meetings.ts";
import { attachMeetingVideos } from "./meeting-videos.ts";
import { collectMeetings } from "./meetings.ts";
import {
  escapeInlineMarkdown,
  eventMarkdown,
  formatDate,
  formatIdentifier,
  hasNextStageLabel,
  labelsToStage,
  parseRelated,
  stageLabel,
  stageWeight,
  summarizeEvent,
  trackedLabelName,
  tidyTitle,
} from "../lib/format.ts";
import type {
  ActivityEntry,
  CommitsPushedEvent,
  Event,
  RfcFrontmatter,
  RfcSummary,
  SiteData,
  Stage,
  StatusChangedEvent,
} from "../lib/types.ts";

const execFile = promisify(execFileCallback);
const ROOT = process.cwd();
const GENERATED_DIR = path.join(ROOT, "generated");
const RFCS_DIR = path.join(GENERATED_DIR, "rfcs");
const DATA_PATH = path.join(GENERATED_DIR, "site.json");
const STATE_PATH = path.join(ROOT, "state.json");
const TEMP_DIR = path.join(ROOT, "temp");
const WG_DIR = path.join(TEMP_DIR, "graphql-wg");
const GRAPHQL_SPEC_PR_QUERY = `
query GetSpecPRs($after: String) {
  organization(login: "graphql") {
    repository(name: "graphql-spec") {
      pullRequests(
        first: 100
        after: $after
        orderBy: { field: UPDATED_AT, direction: DESC }
        labels: [
          "🗑 Rejected (RFC X)"
          "💭 Strawman (RFC 0)"
          "📄 Draft (RFC 2)"
          "🏁 Accepted (RFC 3)"
          "💡 Proposal (RFC 1)"
        ]
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          body
          createdAt
          updatedAt
          closedAt
          mergedAt
          author {
            login
          }
          mergedBy {
            login
          }
          assignees(first: 10) {
            nodes {
              login
            }
          }
          labels(first: 100) {
            nodes {
              name
            }
          }
          commits(last: 100) {
            nodes {
              commit {
                commitUrl
                messageHeadline
                authoredDate
                author {
                  user {
                    login
                  }
                  name
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const GRAPHQL_WG_DISCUSSIONS_QUERY = `
query GetWgDiscussions($after: String) {
  organization(login: "graphql") {
    repository(name: "graphql-wg") {
      discussions(
        first: 100
        after: $after
        orderBy: { field: UPDATED_AT, direction: DESC }
        categoryId: "DIC_kwDOBervg84B_uIH" # "Ideas"
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          body
          createdAt
          updatedAt
          author {
            login
          }
          labels(first: 100) {
            nodes {
              name
            }
          }
        }
      }
    }
  }
}
`;

const GRAPHQL_ISSUE_EVENTS_QUERY = `
query GetIssueEvents(
  $org: String!
  $repo: String!
  $number: Int!
  $timelineSince: DateTime
) {
  repository(owner: $org, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(
        first: 100
        since: $timelineSince
        itemTypes: [LABELED_EVENT, UNLABELED_EVENT]
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on LabeledEvent {
            createdAt
            actor {
              login
            }
            label {
              name
            }
          }
          ... on UnlabeledEvent {
            createdAt
            actor {
              login
            }
            label {
              name
            }
          }
        }
      }
      userContentEdits(first: 100) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          editedAt
          editor {
            login
          }
        }
      }
    }
  }
}
`;

interface RfcRecord {
  identifier: string;
  title: string;
  shortname: string;
  stage: Stage;
  champion?: string;
  closedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
  issueUrl?: string;
  prUrl?: string;
  wgDiscussionUrl?: string;
  rfcDocUrl?: string;
  nextStage?: boolean;
  related: Set<string>;
  events: Event[];
  prBody?: string;
  discussionBody?: string;
  documentBody?: string;
  updatedAt: string;
}

interface SpecPrNode {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  author: { login: string | null } | null;
  mergedBy: { login: string | null } | null;
  assignees: { nodes: Array<{ login: string | null } | null> };
  labels: { nodes: Array<{ name: string | null } | null> };
  commits: {
    nodes: Array<{
      commit: {
        commitUrl: string;
        messageHeadline: string;
        authoredDate: string;
        author: {
          user: { login: string | null } | null;
          name: string | null;
        } | null;
      };
    } | null>;
  };
}

interface DiscussionNode {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string | null } | null;
  labels: { nodes: Array<{ name: string | null } | null> };
}

interface SyncState {
  issueEvents?: Record<
    string,
    {
      updatedAt: string;
      events: CachedIssueEvent[];
    }
  >;
}

interface CachedIssueEvent {
  type: "labeled" | "unlabeled" | "edited";
  date: string;
  actor: string | null;
  label?: string;
}

interface IssueEventsQueryResult {
  repository: {
    pullRequest: {
      timelineItems: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<
          | {
              __typename: "LabeledEvent";
              createdAt: string;
              actor: { login: string | null } | null;
              label: { name: string | null } | null;
            }
          | {
              __typename: "UnlabeledEvent";
              createdAt: string;
              actor: { login: string | null } | null;
              label: { name: string | null } | null;
            }
          | null
        >;
      };
      userContentEdits: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<{
          editedAt: string;
          editor: { login: string | null } | null;
        } | null>;
      };
    } | null;
  } | null;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for sync-rfcs.");
  }

  await fs.mkdir(RFCS_DIR, { recursive: true });
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await Promise.all(
    [...new Set([...groupIds, ...Object.keys(documentOrigins)])].map(
      ensureWgCheckout,
    ),
  );
  const state = await loadState();

  const records = new Map<string, RfcRecord>();

  for (const pr of await fetchAllSpecPrs(token)) {
    mergeSpecPr(records, pr);
    const issueKey = issueKeyFor("graphql", "graphql-spec", pr.number);
    for (const event of getTrackedIssueEvents(
      await getCachedIssueEvents(state, token, issueKey, pr.updatedAt),
      recordIssueHref("graphql", "graphql-spec", pr.number),
    )) {
      const record = records.get(String(pr.number));
      if (record) {
        addEvent(record, event);
      }
    }
  }
  for (const discussion of await fetchAllDiscussions(token)) {
    mergeDiscussion(records, discussion);
  }
  await mergeDocuments(records);
  await collectProjects(records, token);
  for (const record of records.values()) {
    for (const body of [
      record.prBody,
      record.discussionBody,
      record.documentBody,
    ]) {
      for (const match of (body ?? "").matchAll(
        /https:\/\/github\.com\/graphql\/([\w-]+)\/(?:issues|pull|discussions)\/(\d+)/gi,
      )) {
        const repo =
          match[1] === "composite-schemas-spec"
            ? "graphql-federation-spec"
            : match[1];
        const project = projects.find((project) => project.repo === repo);
        if (project) record.related.add(project.alias + "-" + match[2]);
      }
    }
    for (const related of record.related)
      if (!records.has(related)) record.related.delete(related);
  }
  const meetings = await collectMeetings(
    (group) => path.join(TEMP_DIR, group),
    records.values(),
  );

  await attachMeetingVideos(meetings);
  for (const meeting of meetings) {
    if (meeting.cancelled) continue;
    for (const { identifier, agenda, section } of meeting.references) {
      const record = records.get(identifier);
      if (!record) continue;
      const core = {
        group: meeting.group,
        date: meeting.date,
        href: meetingHref(meeting),
        actor: null,
      };
      if (agenda) addEvent(record, { ...core, type: "wgAgenda" });
      if (section)
        addEvent(record, {
          ...core,
          type: "wgNotes",
          href: core.href + "#" + section,
        });
    }
  }

  const summaries = await writeGeneratedMarkdown(records);
  const activity = summaries
    .flatMap<ActivityEntry>((summary) =>
      summary.events.map((event) => ({
        identifier: summary.identifier,
        title: summary.title,
        shortname: summary.shortname,
        stage: summary.stage,
        project: summary.project,
        event,
      })),
    )
    .sort(
      (left, right) =>
        Date.parse(right.event.date) - Date.parse(left.event.date),
    );

  const siteData: SiteData = {
    generatedAt: new Date().toISOString(),
    totalCount: summaries.length,
    rfcs: summaries,
    activity,
    meetings,
  };

  await fs.writeFile(
    DATA_PATH,
    JSON.stringify(siteData, null, 2) + "\n",
    "utf8",
  );
  await saveState(state);
}

async function loadState(): Promise<SyncState> {
  try {
    const state = JSON.parse(
      await fs.readFile(STATE_PATH, "utf8"),
    ) as SyncState;
    if (!state.issueEvents || typeof state.issueEvents !== "object") {
      return {};
    }
    return {
      issueEvents: Object.fromEntries(
        Object.entries(state.issueEvents).flatMap(([key, value]) => {
          if (
            !value ||
            typeof value !== "object" ||
            !Array.isArray(value.events)
          ) {
            return [];
          }
          const events = value.events.filter(isCachedIssueEvent);
          return [[key, { updatedAt: value.updatedAt ?? "", events }]];
        }),
      ),
    };
  } catch {
    return {};
  }
}

async function saveState(state: SyncState): Promise<void> {
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify(sortJson(state), null, 2) + "\n",
    "utf8",
  );
}

async function ensureWgCheckout(group: string): Promise<void> {
  const directory = path.join(TEMP_DIR, group);
  if (!existsSync(directory)) {
    await run("git", [
      "clone",
      "--branch",
      "main",
      `https://github.com/graphql/${group}.git`,
      directory,
    ]);
    return;
  }
  await run("git", ["-C", directory, "fetch", "origin", "main"]);
  await run("git", ["-C", directory, "checkout", "main"]);
  await run("git", ["-C", directory, "merge", "--ff-only", "FETCH_HEAD"]);
}

async function fetchAllSpecPrs(token: string): Promise<SpecPrNode[]> {
  const items: SpecPrNode[] = [];
  let after: string | null = null;
  do {
    const result: {
      organization: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: SpecPrNode[];
          };
        };
      };
    } = await graphql(GRAPHQL_SPEC_PR_QUERY, {
      headers: {
        authorization: `token ${token}`,
      },
      after,
    });
    items.push(...result.organization.repository.pullRequests.nodes);
    after = result.organization.repository.pullRequests.pageInfo.hasNextPage
      ? result.organization.repository.pullRequests.pageInfo.endCursor
      : null;
  } while (after);
  return items;
}

async function fetchAllDiscussions(token: string): Promise<DiscussionNode[]> {
  const items: DiscussionNode[] = [];
  let after: string | null = null;
  do {
    const result: {
      organization: {
        repository: {
          discussions: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: DiscussionNode[];
          };
        };
      };
    } = await graphql(GRAPHQL_WG_DISCUSSIONS_QUERY, {
      headers: {
        authorization: `token ${token}`,
      },
      after,
    });
    items.push(...result.organization.repository.discussions.nodes);
    after = result.organization.repository.discussions.pageInfo.hasNextPage
      ? result.organization.repository.discussions.pageInfo.endCursor
      : null;
  } while (after);
  return items;
}

function mergeSpecPr(records: Map<string, RfcRecord>, pr: SpecPrNode): void {
  const identifier = String(pr.number);
  const labels = pr.labels.nodes.map((node) => node?.name ?? undefined);
  const record = getOrCreateRecord(records, identifier, tidyTitle(pr.title));
  record.title = tidyTitle(pr.title);
  record.shortname = record.title;
  record.stage = labelsToStage(labels);
  record.champion =
    pr.assignees.nodes[0]?.login ?? pr.author?.login ?? undefined;
  record.closedAt = pr.closedAt ?? undefined;
  record.mergedAt = pr.mergedAt ?? undefined;
  record.mergedBy = pr.mergedBy?.login ?? undefined;
  record.prUrl = `https://github.com/graphql/graphql-spec/pull/${pr.number}`;
  record.nextStage = hasNextStageLabel(labels);
  record.prBody = pruneMarkdown(pr.body);
  record.updatedAt = maxDate(record.updatedAt, pr.updatedAt);
  for (const related of parseRelated(pr.body)) {
    record.related.add(related);
  }

  addEvent(record, {
    type: "prCreated",
    date: pr.createdAt,
    href: record.prUrl,
    actor: pr.author?.login ?? null,
  });

  if (pr.mergedAt) {
    addEvent(record, {
      type: "prMerged",
      date: pr.mergedAt,
      href: record.prUrl,
      actor: pr.mergedBy?.login ?? null,
    });
  } else if (pr.closedAt) {
    addEvent(record, {
      type: "prClosed",
      date: pr.closedAt,
      href: record.prUrl,
      actor: null,
    });
  }

  addCommitEvents(record, pr.commits, record.prUrl);
}

function addCommitEvents(
  record: RfcRecord,
  connection: SpecPrNode["commits"],
  href: string,
) {
  const commitsByDate = new Map<string, CommitsPushedEvent["commits"]>();
  for (const node of connection.nodes) {
    const commit = node?.commit;
    if (!commit) {
      continue;
    }
    const key = formatDate(commit.authoredDate);
    const commits = commitsByDate.get(key) ?? [];
    commits.push({
      href: commit.commitUrl,
      headline: commit.messageHeadline,
      ghUser: commit.author?.user?.login ?? null,
      authorName: commit.author?.name ?? null,
    });
    commitsByDate.set(key, commits);
  }
  for (const [date, commits] of commitsByDate) {
    addEvent(record, {
      type: "commitsPushed",
      date,
      href: commits[commits.length - 1]?.href ?? href,
      actor:
        commits[commits.length - 1]?.ghUser ??
        commits[commits.length - 1]?.authorName ??
        null,
      commits,
    });
  }
}

async function getCachedIssueEvents(
  state: SyncState,
  token: string,
  key: string,
  updatedAt: string,
): Promise<CachedIssueEvent[]> {
  state.issueEvents ??= {};
  const cached = state.issueEvents[key];
  if (cached && cached.updatedAt === updatedAt) {
    return cached.events;
  }

  const { org, repo, number } = parseIssueKey(key);
  const events = await fetchIssueEvents(
    token,
    org,
    repo,
    number,
    cached?.events ?? [],
  );
  state.issueEvents[key] = {
    updatedAt,
    events,
  };
  return events;
}

async function fetchIssueEvents(
  token: string,
  org: string,
  repo: string,
  issueNumber: number,
  previousEvents: CachedIssueEvent[],
): Promise<CachedIssueEvent[]> {
  const timelineSince = getLatestCachedIssueEventDate(previousEvents, [
    "labeled",
    "unlabeled",
  ]);
  const latestTopCommentEditAt = getLatestCachedIssueEventDate(previousEvents, [
    "edited",
  ]);

  const result = await graphql<IssueEventsQueryResult>(
    GRAPHQL_ISSUE_EVENTS_QUERY,
    {
      headers: {
        authorization: `token ${token}`,
      },
      org,
      repo,
      number: issueNumber,
      timelineSince,
    },
  );

  const pullRequest = result.repository?.pullRequest;
  if (!pullRequest) {
    return previousEvents;
  }

  const nextEvents: CachedIssueEvent[] = [];

  for (const timelineItem of pullRequest.timelineItems.nodes) {
    if (!timelineItem) {
      continue;
    }
    if (
      timelineItem.__typename !== "LabeledEvent" &&
      timelineItem.__typename !== "UnlabeledEvent"
    ) {
      continue;
    }
    const label = trackedLabelName(timelineItem.label?.name ?? "");
    if (!label) {
      continue;
    }
    nextEvents.push({
      type:
        timelineItem.__typename === "LabeledEvent" ? "labeled" : "unlabeled",
      date: timelineItem.createdAt,
      actor: timelineItem.actor?.login ?? null,
      label,
    });
  }

  for (const contentEdit of pullRequest.userContentEdits.nodes) {
    if (!contentEdit) {
      continue;
    }
    if (
      latestTopCommentEditAt &&
      Date.parse(contentEdit.editedAt) <= Date.parse(latestTopCommentEditAt)
    ) {
      continue;
    }
    nextEvents.push({
      type: "edited",
      date: contentEdit.editedAt,
      actor: contentEdit.editor?.login ?? null,
    });
  }

  return mergeCachedIssueEvents(previousEvents, nextEvents);
}

function getTrackedIssueEvents(
  issueEvents: CachedIssueEvent[],
  href: string,
): Event[] {
  const labelEventsByDay = new Map<string, CachedIssueEvent[]>();
  const latestEditByDay = new Map<string, CachedIssueEvent>();

  for (const issueEvent of issueEvents) {
    if (issueEvent.type === "labeled" || issueEvent.type === "unlabeled") {
      const day = formatDate(issueEvent.date);
      const events = labelEventsByDay.get(day) ?? [];
      events.push(issueEvent);
      labelEventsByDay.set(day, events);
      continue;
    }
    if (issueEvent.type === "edited") {
      const day = formatDate(issueEvent.date);
      const latestEdit = latestEditByDay.get(day);
      if (
        !latestEdit ||
        Date.parse(issueEvent.date) > Date.parse(latestEdit.date)
      ) {
        latestEditByDay.set(day, issueEvent);
      }
    }
  }

  const statusEvents = [...labelEventsByDay.entries()]
    .map(([day, dayEvents]) =>
      summarizeTrackedLabelEvents(day, dayEvents, href),
    )
    .filter((event): event is StatusChangedEvent => event != null);
  const editEvents = [...latestEditByDay.values()].map(
    (issueEvent) =>
      ({
        type: "topCommentEdited",
        date: issueEvent.date,
        href,
        actor: issueEvent.actor,
      }) satisfies Event,
  );

  return [...statusEvents, ...editEvents].sort(
    (left, right) => Date.parse(right.date) - Date.parse(left.date),
  );
}

function summarizeTrackedLabelEvents(
  day: string,
  issueEvents: CachedIssueEvent[],
  href: string,
): StatusChangedEvent | null {
  const tracked = issueEvents
    .map((issueEvent) => ({
      action: issueEvent.type,
      actor: issueEvent.actor,
      createdAt: issueEvent.date,
      label: issueEvent.label ?? null,
    }))
    .filter(
      (
        issueEvent,
      ): issueEvent is {
        action: "labeled" | "unlabeled";
        actor: string | null;
        createdAt: string;
        label: string;
      } => issueEvent.action !== "edited" && issueEvent.label != null,
    )
    .sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );

  if (tracked.length === 0) {
    return null;
  }

  const actor = tracked[tracked.length - 1]?.actor ?? null;
  const summary =
    summarizeStageTransition(tracked) ??
    summarizeStageRemoval(tracked) ??
    summarizeStaleTransition(tracked) ??
    summarizeNextStageTransition(tracked);

  if (!summary) {
    return null;
  }

  return {
    type: "statusChanged",
    date: day,
    href,
    actor,
    summary,
  };
}

function summarizeStageTransition(
  issueEvents: Array<{
    action: "labeled" | "unlabeled";
    actor: string | null;
    createdAt: string;
    label: string;
  }>,
): string | null {
  const addedStage = issueEvents
    .filter((issueEvent) => issueEvent.action === "labeled")
    .map((issueEvent) => issueEvent.label)
    .filter(isStageLikeLabel)
    .sort(compareStageLabelsDescending)[0];
  if (!addedStage) {
    return null;
  }

  switch (addedStage) {
    case "RFC 0":
    case "RFC 1":
    case "RFC 2":
    case "RFC 3":
      return `Advanced to ${addedStage}`;
    case "RFC X / Superseded":
      return "Marked as Superseded";
    case "RFC X":
      return "Marked as Rejected";
    default:
      return null;
  }
}

function summarizeStageRemoval(
  issueEvents: Array<{
    action: "labeled" | "unlabeled";
    actor: string | null;
    createdAt: string;
    label: string;
  }>,
): string | null {
  const removedStage = issueEvents
    .filter((issueEvent) => issueEvent.action === "unlabeled")
    .map((issueEvent) => issueEvent.label)
    .find(isStageLikeLabel);
  if (!removedStage) {
    return null;
  }
  return null;
}

function summarizeStaleTransition(
  issueEvents: Array<{
    action: "labeled" | "unlabeled";
    actor: string | null;
    createdAt: string;
    label: string;
  }>,
): string | null {
  const staleAdded = issueEvents.some(
    (issueEvent) =>
      issueEvent.action === "labeled" && issueEvent.label === "Stale",
  );
  if (staleAdded) {
    return "Marked as Stale";
  }

  const staleRemoved = issueEvents.some(
    (issueEvent) =>
      issueEvent.action === "unlabeled" && issueEvent.label === "Stale",
  );
  if (staleRemoved) {
    return "Marked as Active";
  }

  return null;
}

function summarizeNextStageTransition(
  issueEvents: Array<{
    action: "labeled" | "unlabeled";
    actor: string | null;
    createdAt: string;
    label: string;
  }>,
): string | null {
  const nextStageAdded = issueEvents.some(
    (issueEvent) =>
      issueEvent.action === "labeled" && issueEvent.label === "Next stage",
  );
  if (nextStageAdded) {
    return "Marked as Ready for Next Stage";
  }
  return null;
}

function isStageLikeLabel(label: string): boolean {
  return (
    label === "RFC 0" ||
    label === "RFC 1" ||
    label === "RFC 2" ||
    label === "RFC 3" ||
    label === "RFC X" ||
    label === "RFC X / Superseded"
  );
}

function compareStageLabelsDescending(left: string, right: string): number {
  return stageWeight(labelToStage(right)) - stageWeight(labelToStage(left));
}

function labelToStage(label: string): Stage {
  switch (label) {
    case "RFC 0":
      return "0";
    case "RFC 1":
      return "1";
    case "RFC 2":
      return "2";
    case "RFC 3":
      return "3";
    case "RFC X":
      return "X";
    case "RFC X / Superseded":
      return "S";
    default:
      return null;
  }
}

function issueKeyFor(org: string, repo: string, number: number): string {
  return `${org}/${repo}#${number}`;
}

function mergeCachedIssueEvents(
  previousEvents: CachedIssueEvent[],
  nextEvents: CachedIssueEvent[],
): CachedIssueEvent[] {
  const deduped = new Map<string, CachedIssueEvent>();
  for (const issueEvent of [...previousEvents, ...nextEvents]) {
    deduped.set(cachedIssueEventKey(issueEvent), issueEvent);
  }
  return [...deduped.values()].sort(compareCachedIssueEvents);
}

function cachedIssueEventKey(issueEvent: CachedIssueEvent): string {
  return [
    issueEvent.type,
    issueEvent.date,
    issueEvent.actor ?? "",
    issueEvent.label ?? "",
  ].join("|");
}

function compareCachedIssueEvents(
  left: CachedIssueEvent,
  right: CachedIssueEvent,
): number {
  const dateDelta = Date.parse(left.date) - Date.parse(right.date);
  if (dateDelta !== 0) {
    return dateDelta;
  }
  const typeDelta = left.type.localeCompare(right.type);
  if (typeDelta !== 0) {
    return typeDelta;
  }
  const actorDelta = (left.actor ?? "").localeCompare(right.actor ?? "");
  if (actorDelta !== 0) {
    return actorDelta;
  }
  return (left.label ?? "").localeCompare(right.label ?? "");
}

function getLatestCachedIssueEventDate(
  issueEvents: CachedIssueEvent[],
  types: CachedIssueEvent["type"][],
): string | null {
  const dates = issueEvents
    .filter((issueEvent) => types.includes(issueEvent.type))
    .map((issueEvent) => issueEvent.date)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return dates[0] ?? null;
}

function isCachedIssueEvent(value: unknown): value is CachedIssueEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const issueEvent = value as Partial<CachedIssueEvent>;
  if (
    issueEvent.type !== "labeled" &&
    issueEvent.type !== "unlabeled" &&
    issueEvent.type !== "edited"
  ) {
    return false;
  }
  if (typeof issueEvent.date !== "string") {
    return false;
  }
  if (issueEvent.actor != null && typeof issueEvent.actor !== "string") {
    return false;
  }
  if (issueEvent.label != null && typeof issueEvent.label !== "string") {
    return false;
  }
  return true;
}

function parseIssueKey(key: string): {
  org: string;
  repo: string;
  number: number;
} {
  const match = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    throw new Error(`Invalid issue key: ${key}`);
  }
  return {
    org: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

function recordIssueHref(org: string, repo: string, number: number): string {
  return `https://github.com/${org}/${repo}/pull/${number}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, inner]) => [key, sortJson(inner)]),
    );
  }
  return value;
}

function mergeDiscussion(
  records: Map<string, RfcRecord>,
  discussion: DiscussionNode,
): void {
  const identifier = `wg${discussion.number}`;
  const labels = discussion.labels.nodes.map((node) => node?.name ?? undefined);
  const record = getOrCreateRecord(
    records,
    identifier,
    tidyTitle(discussion.title),
  );
  record.title = tidyTitle(discussion.title);
  record.shortname = record.title;
  record.stage = labelsToStage(labels) ?? "0";
  record.champion = discussion.author?.login ?? undefined;
  record.wgDiscussionUrl = `https://github.com/graphql/graphql-wg/discussions/${discussion.number}`;
  record.discussionBody = pruneMarkdown(discussion.body);
  record.updatedAt = maxDate(record.updatedAt, discussion.updatedAt);
  for (const related of parseRelated(discussion.body, "wg")) {
    record.related.add(related);
  }

  addEvent(record, {
    type: "wgDiscussionCreated",
    date: discussion.createdAt,
    href: record.wgDiscussionUrl,
    actor: discussion.author?.login ?? null,
  });
}

async function mergeDocuments(records: Map<string, RfcRecord>): Promise<void> {
  const docsDir = path.join(WG_DIR, "rfcs");
  for (const entry of await fs.readdir(docsDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".md") ||
      entry.name === "README.md" ||
      entry.name === "TEMPLATE.md"
    ) {
      continue;
    }
    const fullPath = path.join(docsDir, entry.name);
    const identifier = entry.name.slice(0, -3);
    const content = await fs.readFile(fullPath, "utf8");
    const [header = identifier] = content.split("\n", 1);
    const record = getOrCreateRecord(records, identifier, tidyTitle(header));
    record.title = tidyTitle(header);
    record.shortname = record.title;
    record.stage = record.stage ?? "0";
    record.rfcDocUrl = `https://github.com/graphql/graphql-wg/blob/main/rfcs/${entry.name}`;
    record.documentBody = pruneMarkdown(content);

    for (const related of parseRelated(content, "wg")) {
      record.related.add(related);
    }

    const log = await run("git", [
      "-C",
      WG_DIR,
      "log",
      "--follow",
      "--format=%H%x09%aI%x09%an",
      "--",
      `rfcs/${entry.name}`,
    ]);
    const commits = log
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...rest] = line.split("\t");
        return { hash, date, author: rest.join("\t") };
      });
    const total = commits.length;
    commits.forEach((commit, index) => {
      addEvent(record, {
        type: index === total - 1 ? "docCreated" : "docUpdated",
        date: commit.date,
        href: `https://github.com/graphql/graphql-wg/blob/${commit.hash}/rfcs/${entry.name}`,
        actor: commit.author,
      });
    });
  }
}

async function writeGeneratedMarkdown(
  records: Map<string, RfcRecord>,
): Promise<RfcSummary[]> {
  const summaries = [...records.values()]
    .map((record) => buildSummary(record))
    .sort(compareRfcSummaries);

  await Promise.all(
    summaries.map(async (summary) => {
      const markdownPath = path.join(RFCS_DIR, `${summary.identifier}.md`);
      const frontmatter: RfcFrontmatter = {
        title: summary.title,
        identifier: summary.identifier,
        shortname: summary.shortname,
        stage: summary.stage,
        champion: summary.champion,
        closedAt: summary.closedAt,
        mergedAt: summary.mergedAt,
        mergedBy: summary.mergedBy,
        project: summary.project,
        issueUrl: summary.issueUrl,
        prUrl: summary.prUrl,
        wgDiscussionUrl: summary.wgDiscussionUrl,
        rfcDocUrl: summary.rfcDocUrl,
        nextStage: summary.nextStage,
        related: summary.related,
        events: summary.events,
        updatedAt: summary.updatedAt,
        description: summary.description,
      };
      const record = records.get(summary.identifier);
      if (!record) {
        throw new Error(`Missing RFC record for ${summary.identifier}`);
      }
      const content = [
        "---",
        YAML.stringify(frontmatter).trimEnd(),
        "---",
        "",
        `# ${summary.title}`,
        "",
        "## At a glance",
        "",
        `- Identifier: ${formatIdentifier(summary.identifier)}`,
        `- Stage: ${stageLabel(summary.stage)}`,
        `- Champion: ${summary.champion ? `[@${summary.champion}](https://github.com/${summary.champion})` : "-"}`,
        `- Latest activity: ${escapeInlineMarkdown(summarizeEvent(summary.events[0]))}`,
        ...(summary.issueUrl
          ? [`- Issue: [${summary.issueUrl}](${summary.issueUrl})`]
          : []),
        ...(summary.prUrl
          ? [`- Pull request: [${summary.prUrl}](${summary.prUrl})`]
          : []),
        ...(summary.rfcDocUrl
          ? [`- RFC document: [${summary.rfcDocUrl}](${summary.rfcDocUrl})`]
          : []),
        ...(summary.wgDiscussionUrl
          ? [
              `- WG discussion: [${summary.wgDiscussionUrl}](${summary.wgDiscussionUrl})`,
            ]
          : []),
        ...(summary.related.length > 0
          ? [
              "- Related:",
              ...summary.related.map(
                (related) =>
                  `  - [${formatIdentifier(related)}](/rfcs/${related}/)`,
              ),
            ]
          : []),
        "",
        ...renderContentSections(record),
        "## Timeline",
        "",
        ...summary.events.map((event) => eventMarkdown(event)),
        "",
      ].join("\n");
      await fs.writeFile(markdownPath, content, "utf8");
    }),
  );

  for (const entry of await fs.readdir(RFCS_DIR, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !records.has(entry.name.slice(0, -3))
    ) {
      await fs.unlink(path.join(RFCS_DIR, entry.name));
    }
  }
  return summaries;
}

function renderContentSections(record: RfcRecord): string[] {
  const sections: string[] = [];
  if (record.documentBody) {
    sections.push("## RFC document", "", record.documentBody.trim(), "");
  }
  if (record.prBody && record.prBody !== record.documentBody) {
    sections.push(
      record.issueUrl ? "## Issue description" : "## Pull request description",
      "",
      record.prBody.trim(),
      "",
    );
  }
  if (record.discussionBody && record.discussionBody !== record.documentBody) {
    sections.push("## WG discussion", "", record.discussionBody.trim(), "");
  }
  if (sections.length === 0) {
    sections.push(
      "## Source content",
      "",
      "No source markdown was available for this entry at sync time.",
      "",
    );
  }
  return sections;
}

function buildSummary(record: RfcRecord): RfcSummary {
  const related = [...record.related]
    .filter((value) => value !== record.identifier)
    .sort();
  const events = [...record.events].sort(
    (left, right) => Date.parse(right.date) - Date.parse(left.date),
  );
  return {
    identifier: record.identifier,
    title: record.title,
    shortname: record.shortname,
    stage: record.stage,
    champion: record.champion,
    closedAt: record.closedAt,
    mergedAt: record.mergedAt,
    mergedBy: record.mergedBy,
    project: projectName(record.identifier),
    issueUrl: record.issueUrl,
    prUrl: record.prUrl,
    wgDiscussionUrl: record.wgDiscussionUrl,
    rfcDocUrl: record.rfcDocUrl,
    nextStage: record.nextStage,
    related,
    events,
    updatedAt: record.updatedAt,
    markdownPath: `generated/rfcs/${record.identifier}.md`,
    description: `${record.title}. ${summarizeEvent(events[0])}.`,
  };
}

function compareRfcSummaries(left: RfcSummary, right: RfcSummary): number {
  const supersededWeight =
    (left.stage === "S" ? 1 : 0) - (right.stage === "S" ? 1 : 0);
  if (supersededWeight !== 0) {
    return supersededWeight;
  }
  const closedWeight =
    (left.closedAt && !left.mergedAt ? 1 : 0) -
    (right.closedAt && !right.mergedAt ? 1 : 0);
  if (closedWeight !== 0) {
    return closedWeight;
  }
  const stageDelta = stageWeight(right.stage) - stageWeight(left.stage);
  if (stageDelta !== 0) {
    return stageDelta;
  }
  const nextStageDelta =
    Number(right.nextStage ?? false) - Number(left.nextStage ?? false);
  if (nextStageDelta !== 0) {
    return nextStageDelta;
  }
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function getOrCreateRecord(
  records: Map<string, RfcRecord>,
  identifier: string,
  title: string,
): RfcRecord {
  const existing = records.get(identifier);
  if (existing) {
    return existing;
  }
  const created: RfcRecord = {
    identifier,
    title,
    shortname: title,
    stage: null,
    related: new Set<string>(),
    events: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  records.set(identifier, created);
  return created;
}

function addEvent(record: RfcRecord, event: Event): void {
  const signature = eventSignature(event);
  const seen = new Set(
    record.events.map((existing) => eventSignature(existing)),
  );
  if (!seen.has(signature)) {
    record.events.push(event);
  }
  record.updatedAt = maxDate(record.updatedAt, event.date);
}

function eventSignature(event: Event): string {
  if (event.type === "commitsPushed") {
    return `${event.type}:${event.date}:${event.commits.map((commit) => commit.href).join(",")}`;
  }
  return `${event.type}:${event.date}:${event.href}`;
}

function pruneMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").trim();
}

function maxDate(left: string, right: string): string {
  return Date.parse(left) > Date.parse(right) ? left : right;
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(command, args, {
    cwd: ROOT,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

interface ProjectItem extends DiscussionNode {
  id: string;
  lastEditedAt?: string;
  editor?: { login: string };
  mergedBy?: { login: string };
  url: string;
  closedAt?: string;
  mergedAt?: string;
}

const documentOrigins: Record<string, Record<string, number>> = {
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

async function projectDocuments(
  repo: string,
  token: string,
): Promise<Record<string, number>> {
  if (!(repo in documentOrigins)) return {};
  const root = path.join(TEMP_DIR, repo);
  const result: Record<string, number> = {};
  for (const entry of await fs.readdir(path.join(root, "rfcs"), {
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      !/\.(md|pdf)$/i.test(entry.name) ||
      /^(README|TEMPLATE)\./i.test(entry.name)
    )
      continue;
    const reviewed = documentOrigins[repo][entry.name];
    if (reviewed) {
      result[entry.name] = reviewed;
      continue;
    }
    const log = await run("git", [
      "-C",
      root,
      "log",
      "--follow",
      "--diff-filter=A",
      "--format=%H",
      "--",
      "rfcs/" + entry.name,
    ]);
    const oid = log.trim().split("\n").at(-1);
    const response: {
      repository: {
        object: { associatedPullRequests: { nodes: { number: number }[] } };
      };
    } = await graphql(
      `
        query ($repo: String!, $oid: GitObjectID!) {
          repository(owner: "graphql", name: $repo) {
            object(oid: $oid) {
              ... on Commit {
                associatedPullRequests(first: 2) {
                  nodes {
                    number
                  }
                }
              }
            }
          }
        }
      `,
      { repo, oid, headers: { authorization: `token ${token}` } },
    );
    const candidates = response.repository.object.associatedPullRequests.nodes;
    if (candidates.length !== 1) {
      console.warn(`Review origin of ${repo}/rfcs/${entry.name}`);
      continue;
    }
    result[entry.name] = candidates[0].number;
  }
  if (new Set(Object.values(result)).size !== Object.keys(result).length)
    throw new Error(`Review shared document origin in ${repo}`);
  return result;
}

type ProjectItemKind = "issues" | "pullRequests" | "discussions";

// GitHub Discussions has no labels argument on the repository connection.
async function* projectItems(
  repo: string,
  kind: ProjectItemKind,
  labels: string[],
  token: string,
): AsyncGenerator<ProjectItem> {
  const fields =
    "id number url title body author{login} lastEditedAt editor{login} createdAt updatedAt labels(first:100){nodes{name}}";
  if (kind === "discussions") {
    const seen = new Set<string>();
    for (const label of labels) {
      let after: string | null = null;
      do {
        const result: {
          search: {
            nodes: ProjectItem[];
            pageInfo: { hasNextPage: boolean; endCursor: string };
          };
        } = await graphql(
          `query($search:String!,$after:String){search(query:$search,type:DISCUSSION,first:100,after:$after){nodes{... on Discussion{${fields}}} pageInfo{hasNextPage endCursor}}}`,
          {
            search: `repo:graphql/${repo} label:${JSON.stringify(label)}`,
            after,
            headers: { authorization: `token ${token}` },
          },
        );
        for (const item of result.search.nodes) {
          if (
            !seen.has(item.id) &&
            item.labels.nodes.some(
              (node) => node?.name && labels.includes(node.name),
            )
          ) {
            seen.add(item.id);
            yield item;
          }
        }
        after = result.search.pageInfo.hasNextPage
          ? result.search.pageInfo.endCursor
          : null;
      } while (after);
    }
    return;
  }
  const extra =
    kind === "issues" ? "closedAt" : "closedAt mergedAt mergedBy{login}";
  const query = `query($repo:String!, $after:String, $labels:[String!]!){
        repository(owner:"graphql",name:$repo){
          items:${kind}(first:100,after:$after,labels:$labels){
            pageInfo{hasNextPage endCursor}
            nodes{${fields} ${extra}}
          }
        }
      }`;
  let after: string | null = null;
  do {
    const response: {
      repository: {
        items: {
          nodes: ProjectItem[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      };
    } = await graphql(query, {
      repo,
      labels,
      after,
      headers: { authorization: `token ${token}` },
    });
    const { nodes, pageInfo } = response.repository.items;
    yield* nodes;
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
}

async function collectProjects(records: Map<string, RfcRecord>, token: string) {
  const legacy = new Set(records.keys());
  for (const { repo, alias } of projects) {
    const result = await graphql<{
      repository: { labels: { nodes: { name: string }[] } };
    }>(
      `
        query ($repo: String!) {
          repository(owner: "graphql", name: $repo) {
            labels(first: 100, query: "RFC") {
              nodes {
                name
              }
            }
          }
        }
      `,
      { repo, headers: { authorization: `token ${token}` } },
    );
    const rfcLabels = result.repository.labels.nodes
      .map((label) => label.name)
      .filter(
        (name) => /^rfc$/i.test(name) || /(?:^|\()RFC [0123X]\)?$/i.test(name),
      );
    if (!rfcLabels.length) continue;
    const trackedPrs = new Map<string, RfcRecord>();
    const documents = await projectDocuments(repo, token);
    console.log("Collecting proposals from graphql/" + repo);
    for (const kind of ["issues", "pullRequests", "discussions"] as const) {
      for await (const item of projectItems(repo, kind, rfcLabels, token)) {
        const labels = item.labels.nodes.map((label) => label?.name ?? "");
        const identifier = `${alias}-${item.number}`;
        if (legacy.has(identifier))
          throw new Error(
            `Project route collides with existing RFC ${identifier}`,
          );
        const record = getOrCreateRecord(
          records,
          identifier,
          tidyTitle(item.title),
        );
        const actor = item.author?.login ?? null;
        const previous =
          record.prUrl ?? record.wgDiscussionUrl ?? record.issueUrl;
        if (previous && previous !== item.url)
          throw new Error(
            `Conflicting origins for ${record.identifier}: ${previous}, ${item.url}`,
          );

        record.title = record.shortname = tidyTitle(item.title);
        record.stage = labelsToStage(labels);
        record.champion = actor ?? undefined;
        record.closedAt = item.closedAt ?? undefined;
        record.mergedAt = item.mergedAt ?? undefined;
        if (kind === "discussions") {
          record.wgDiscussionUrl = item.url;
          record.discussionBody = pruneMarkdown(item.body);
        } else {
          if (kind === "issues") record.issueUrl = item.url;
          else record.prUrl = item.url;
          record.prBody = pruneMarkdown(item.body);
        }
        if (kind === "pullRequests") trackedPrs.set(item.id, record);
        if (item.lastEditedAt)
          addEvent(record, {
            type: "topCommentEdited",
            href: item.url,
            date: item.lastEditedAt,
            actor: item.editor?.login ?? null,
          });
        record.updatedAt = maxDate(record.updatedAt, item.updatedAt);
        addEvent(record, {
          type:
            kind === "issues"
              ? "issueCreated"
              : kind === "discussions"
                ? "wgDiscussionCreated"
                : "prCreated",
          href: item.url,
          date: item.createdAt,
          actor,
        });
        if (item.closedAt)
          addEvent(record, {
            type: item.mergedAt
              ? "prMerged"
              : kind === "issues"
                ? "issueClosed"
                : "prClosed",
            href: item.url,
            date: item.mergedAt ?? item.closedAt,
            actor: item.mergedBy?.login ?? null,
          });
        for (const related of parseRelated(item.body, alias + "-"))
          record.related.add(related);
      }
    }
    const ids = [...trackedPrs.keys()];
    for (let offset = 0; offset < ids.length; offset += 20) {
      const response: {
        nodes: { id: string; url: string; commits: SpecPrNode["commits"] }[];
      } = await graphql(
        `
          query ($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on PullRequest {
                id
                url
                commits(last: 100) {
                  nodes {
                    commit {
                      commitUrl
                      messageHeadline
                      authoredDate
                      author {
                        name
                        user {
                          login
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        {
          ids: ids.slice(offset, offset + 20),
          headers: { authorization: `token ${token}` },
        },
      );
      for (const pr of response.nodes)
        addCommitEvents(trackedPrs.get(pr.id)!, pr.commits, pr.url);
    }
    for (const [file, number] of Object.entries(documents)) {
      const record = records.get(alias + "-" + number);
      if (!record) continue;
      const directory = path.join(TEMP_DIR, repo);
      const relative = "rfcs/" + file;
      record.rfcDocUrl = `https://github.com/graphql/${repo}/blob/main/${relative}`;
      if (file.endsWith(".md"))
        record.documentBody = pruneMarkdown(
          await fs.readFile(path.join(directory, relative), "utf8"),
        );
      const log = await run("git", [
        "-C",
        directory,
        "log",
        "--follow",
        "--format=%H%x09%aI%x09%an",
        "--",
        relative,
      ]);
      const commits = log.trim().split("\n").filter(Boolean).reverse();
      commits.forEach((line, index) => {
        const [hash, date, actor] = line.split("\t");
        addEvent(record, {
          type: index ? "docUpdated" : "docCreated",
          href: `https://github.com/graphql/${repo}/blob/${hash}/${relative}`,
          date,
          actor,
        });
      });
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
