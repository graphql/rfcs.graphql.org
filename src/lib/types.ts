export type Stage = "0" | "1" | "2" | "3" | "X" | "S" | null;

export interface TimelineCommit {
  href: string;
  headline: string;
  ghUser: string | null;
  authorName: string | null;
}

export interface EventCore {
  date: string;
  href: string;
  actor: string | null;
}

export interface EventBase extends EventCore {
  type:
    | "prCreated"
    | "prMerged"
    | "prClosed"
    | "topCommentEdited"
    | "labelAdded"
    | "labelRemoved"
    | "docCreated"
    | "docUpdated"
    | "wgDiscussionCreated"
    | "wgAgenda"
    | "wgNotes";
}

export interface CommitsPushedEvent extends EventCore {
  type: "commitsPushed";
  commits: TimelineCommit[];
}

export interface LabelChangedEvent extends EventCore {
  type: "labelAdded" | "labelRemoved";
  label: string;
}

export type Event = EventBase | CommitsPushedEvent | LabelChangedEvent;

export interface RfcSummary {
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
  related: string[];
  events: Event[];
  updatedAt: string;
  markdownPath: string;
  description: string;
}

export interface ActivityEntry {
  identifier: string;
  title: string;
  shortname: string;
  stage: Stage;
  event: Event;
}

export interface SiteData {
  generatedAt: string;
  totalCount: number;
  rfcs: RfcSummary[];
  activity: ActivityEntry[];
}

export interface RfcFrontmatter {
  title: string;
  identifier: string;
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
  related?: string[];
  events: Event[];
  updatedAt: string;
  description: string;
}
