import type {
  CommitsPushedEvent,
  Event,
  EventBase,
  RfcSummary,
  Stage,
  TimelineCommit,
} from "./types.ts";

export function tidyTitle(title: string): string {
  return title
    .trim()
    .replace(/^#+/, "")
    .trim()
    .replace(/^(?:\[RFC\]|RFC):?/i, "")
    .trim();
}

export function formatIdentifier(identifier: string): string {
  if (/^\d+$/.test(identifier)) {
    return `#${identifier}`;
  }
  if (/^wg\d+$/.test(identifier)) {
    return `wg#${identifier.slice(2)}`;
  }
  return identifier;
}

export function stageLabel(stage: Stage): string {
  switch (stage) {
    case "0":
      return "RFC 0 / Strawman";
    case "1":
      return "RFC 1 / Proposal";
    case "2":
      return "RFC 2 / Draft";
    case "3":
      return "RFC 3 / Accepted";
    case "X":
      return "RFC X / Rejected";
    case "S":
      return "RFC X / Superseded";
    default:
      return "Unknown";
  }
}

export function stageWeight(stage: Stage): number {
  switch (stage) {
    case "3":
      return 5;
    case "2":
      return 4;
    case "1":
      return 3;
    case "0":
      return 2;
    case "S":
      return 1;
    case "X":
      return 0;
    default:
      return -1;
  }
}

export function formatDate(date: string): string {
  if (date.length <= 10) {
    return date;
  }
  return new Date(date).toISOString().slice(0, 10);
}

export function summarizeEvent(event: Event): string {
  if (event.type === "commitsPushed") {
    return `${event.commits.length} commit${event.commits.length === 1 ? "" : "s"} pushed on ${formatDate(event.date)}`;
  }
  switch (event.type) {
    case "prCreated":
      return `Spec PR created on ${formatDate(event.date)}`;
    case "prMerged":
      return `Spec PR merged on ${formatDate(event.date)}`;
    case "prClosed":
      return `Spec PR closed on ${formatDate(event.date)}`;
    case "docCreated":
      return `RFC document created on ${formatDate(event.date)}`;
    case "docUpdated":
      return `RFC document updated on ${formatDate(event.date)}`;
    case "wgDiscussionCreated":
      return `WG discussion created on ${formatDate(event.date)}`;
    case "wgAgenda":
      return `Added to WG agenda on ${formatDate(event.date)}`;
    case "wgNotes":
      return `Mentioned in WG notes on ${formatDate(event.date)}`;
  }
}

function actorLabel(actor: string | null): string {
  return actor ?? "unknown";
}

function commitAuthor(commit: TimelineCommit): string {
  return commit.ghUser ?? commit.authorName ?? "unknown";
}

export function eventMarkdown(event: EventBase | Event): string {
  if (event.type === "commitsPushed") {
    return commitsMarkdown(event);
  }
  switch (event.type) {
    case "prCreated":
      return `- [Spec PR](${event.href}) created on ${formatDate(event.date)} by ${actorLabel(event.actor)}`;
    case "prMerged":
      return `- [Spec PR](${event.href}) merged on ${formatDate(event.date)} by ${actorLabel(event.actor)}`;
    case "prClosed":
      return `- [Spec PR](${event.href}) closed on ${formatDate(event.date)}`;
    case "docCreated":
      return `- [RFC document](${event.href}) created on ${formatDate(event.date)} by ${actorLabel(event.actor)}`;
    case "docUpdated":
      return `- [RFC document](${event.href}) updated on ${formatDate(event.date)} by ${actorLabel(event.actor)}`;
    case "wgDiscussionCreated":
      return `- [WG discussion](${event.href}) created on ${formatDate(event.date)} by ${actorLabel(event.actor)}`;
    case "wgAgenda":
      return `- [Added to WG agenda](${event.href}) on ${formatDate(event.date)}`;
    case "wgNotes":
      return `- Mentioned in [WG notes](${event.href}) on ${formatDate(event.date)}`;
  }
}

function commitsMarkdown(event: CommitsPushedEvent): string {
  if (event.commits.length === 1) {
    const commit = event.commits[0];
    return `- [Commit pushed](${commit.href}) on ${formatDate(event.date)} by ${commitAuthor(commit)}: ${commit.headline}`;
  }
  return [
    `- ${event.commits.length} commits pushed on ${formatDate(event.date)}:`,
    ...event.commits.map(
      (commit) =>
        `  - ${commitAuthor(commit)} committed "[${escapeInlineMarkdown(commit.headline)}](${commit.href})"`,
    ),
  ].join("\n");
}

export function escapeInlineMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

export function summarizeRfc(summary: RfcSummary): string {
  return `${formatIdentifier(summary.identifier)} ${summary.title}`;
}

export function parseRelated(markdown: string, prefix = ""): string[] {
  const related = new Set<string>();
  for (const match of markdown.matchAll(
    /(?:builds on|fixes|relates to|replaces|supercedes|supersedes|identical to|addresses) #([0-9]+)/gi,
  )) {
    related.add(`${prefix}${match[1]}`);
  }
  for (const match of markdown.matchAll(
    /https:\/\/github\.com\/graphql\/graphql-(spec|wg)\/(?:pull|issues|discussions)\/([0-9]+)/gi,
  )) {
    related.add(`${match[1] === "wg" ? "wg" : ""}${match[2]}`);
  }
  for (const match of markdown.matchAll(
    /https:\/\/github\.com\/graphql\/graphql-wg\/blob\/main\/rfcs\/([A-Za-z0-9_-]+)\.md/gi,
  )) {
    related.add(match[1]);
  }
  return [...related].sort();
}

export function labelsToStage(labels: Array<string | undefined>): Stage {
  let match: Stage = null;
  for (const label of labels) {
    if (!label) {
      continue;
    }
    const stageMatch = label.match(/RFC\s*([0123X])/i);
    if (!stageMatch) {
      continue;
    }
    const thisMatch: Stage =
      stageMatch[1]?.toUpperCase() === "X"
        ? /Superseded/i.test(label)
          ? "S"
          : "X"
        : (stageMatch[1] as Exclude<Stage, "X" | "S" | null>);
    if (match === null || thisMatch === "X" || thisMatch === "S") {
      match = thisMatch;
      continue;
    }
    if (match !== thisMatch) {
      throw new Error(`Conflicting RFC stages on labels: ${labels.join(", ")}`);
    }
  }
  return match;
}

export function hasNextStageLabel(labels: Array<string | undefined>): boolean {
  return labels.some((label) => label != null && /next stage/i.test(label));
}
