import { graphql } from "@octokit/graphql";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import YAML from "yaml";
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
  LabelChangedEvent,
  RfcFrontmatter,
  RfcSummary,
  SiteData,
  Stage,
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

interface RfcRecord {
  identifier: string;
  title: string;
  shortname: string;
  stage: Stage;
  champion?: string;
  closedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
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
  prLabelEvents?: Record<
    string,
    {
      updatedAt: string;
      events: LabelChangedEvent[];
    }
  >;
}

interface GitHubIssueEvent {
  event: string;
  created_at: string;
  actor?: {
    login?: string | null;
  } | null;
  label?: {
    name?: string | null;
  } | null;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for sync-rfcs.");
  }

  await fs.mkdir(RFCS_DIR, { recursive: true });
  await ensureGraphqlWgCheckout();
  const state = await loadState();

  const records = new Map<string, RfcRecord>();

  for (const pr of await fetchAllSpecPrs(token)) {
    mergeSpecPr(records, pr);
    for (const event of await getCachedPrLabelEvents(state, token, pr)) {
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
  await addWgMentions(records);

  const summaries = await writeGeneratedMarkdown(records);
  const activity = summaries
    .flatMap<ActivityEntry>((summary) =>
      summary.events.map((event) => ({
        identifier: summary.identifier,
        title: summary.title,
        shortname: summary.shortname,
        stage: summary.stage,
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
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as SyncState;
  } catch {
    return {};
  }
}

async function saveState(state: SyncState): Promise<void> {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function ensureGraphqlWgCheckout(): Promise<void> {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  if (!existsSync(WG_DIR)) {
    await run("git", [
      "clone",
      "https://github.com/graphql/graphql-wg.git",
      WG_DIR,
    ]);
    return;
  }
  await run("git", ["-C", WG_DIR, "fetch", "--all", "--prune"]);
  await run("git", ["-C", WG_DIR, "checkout", "main"]);
  await run("git", ["-C", WG_DIR, "pull", "--ff-only"]);
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

  const commitsByDate = new Map<string, CommitsPushedEvent["commits"]>();
  for (const node of pr.commits.nodes) {
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
      href: commits[commits.length - 1]?.href ?? record.prUrl,
      actor:
        commits[commits.length - 1]?.ghUser ??
        commits[commits.length - 1]?.authorName ??
        null,
      commits,
    });
  }
}

async function getCachedPrLabelEvents(
  state: SyncState,
  token: string,
  pr: SpecPrNode,
): Promise<LabelChangedEvent[]> {
  state.prLabelEvents ??= {};
  const key = String(pr.number);
  const cached = state.prLabelEvents[key];
  if (cached && cached.updatedAt === pr.updatedAt) {
    return cached.events;
  }

  const events = await fetchPrLabelEvents(token, pr.number);
  state.prLabelEvents[key] = {
    updatedAt: pr.updatedAt,
    events,
  };
  return events;
}

async function fetchPrLabelEvents(
  token: string,
  prNumber: number,
): Promise<LabelChangedEvent[]> {
  const events: LabelChangedEvent[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/graphql/graphql-spec/issues/${prNumber}/events?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "rfcs.graphql.org-sync",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch issue events for PR #${prNumber}: ${response.status} ${response.statusText}`,
      );
    }

    const pageEvents = (await response.json()) as GitHubIssueEvent[];
    for (const issueEvent of pageEvents) {
      if (issueEvent.event !== "labeled" && issueEvent.event !== "unlabeled") {
        continue;
      }
      const label = trackedLabelName(issueEvent.label?.name ?? "");
      if (!label) {
        continue;
      }
      events.push({
        type: issueEvent.event === "labeled" ? "labelAdded" : "labelRemoved",
        date: issueEvent.created_at,
        href: `https://github.com/graphql/graphql-spec/pull/${prNumber}`,
        actor: issueEvent.actor?.login ?? null,
        label,
      });
    }

    if (pageEvents.length < 100) {
      break;
    }
    page += 1;
  }

  return events;
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
    record.updatedAt = maxDate(record.updatedAt, new Date().toISOString());
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

async function addWgMentions(records: Map<string, RfcRecord>): Promise<void> {
  for (const group of ["agendas", "notes"]) {
    const baseDir = path.join(WG_DIR, group);
    if (!existsSync(baseDir)) {
      continue;
    }
    for (const filePath of await walkMarkdownFiles(baseDir)) {
      const content = await fs.readFile(filePath, "utf8");
      const eventType = group === "agendas" ? "wgAgenda" : "wgNotes";
      const date = getDateFromPath(filePath);
      const relative = path
        .relative(WG_DIR, filePath)
        .split(path.sep)
        .join("/");
      const href = `https://github.com/graphql/graphql-wg/blob/main/${relative}`;
      for (const match of content.matchAll(
        /https:\/\/github\.com\/graphql\/graphql-spec\/pull\/([0-9]+)/gi,
      )) {
        const record = records.get(match[1]);
        if (!record) {
          continue;
        }
        addEvent(record, {
          type: eventType,
          date,
          href,
          actor: null,
        });
      }
    }
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
        ...(summary.prUrl
          ? [`- Spec PR: [${summary.prUrl}](${summary.prUrl})`]
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

  return summaries;
}

function renderContentSections(record: RfcRecord): string[] {
  const sections: string[] = [];
  if (record.documentBody) {
    sections.push("## RFC document", "", record.documentBody.trim(), "");
  }
  if (record.prBody && record.prBody !== record.documentBody) {
    sections.push("## Spec PR description", "", record.prBody.trim(), "");
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

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkMarkdownFiles(fullPath);
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "README.md"
      ) {
        return [fullPath];
      }
      return [];
    }),
  );
  return files.flat();
}

function getDateFromPath(filePath: string): string {
  const normalized = filePath.replace(/[^0-9-]+/g, "-").replace(/-+/g, "-");
  const full = normalized.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])/);
  if (full) {
    return full[1];
  }
  const partial = normalized.match(/([0-9]{4})-([0-9]{2})(?![0-9])/);
  if (partial) {
    return `${partial[1]}-${partial[2]}-01`;
  }
  return new Date().toISOString().slice(0, 10);
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

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
