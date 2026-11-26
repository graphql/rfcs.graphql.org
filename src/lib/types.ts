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
  group?: string;
  type:
    | "issueCreated"
    | "issueClosed"
    | "prCreated"
    | "prMerged"
    | "prClosed"
    | "topCommentEdited"
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

export interface StatusChangedEvent extends EventCore {
  type: "statusChanged";
  summary: string;
}

export type Event = EventBase | CommitsPushedEvent | StatusChangedEvent;

export interface RfcSummary {
  identifier: string;
  title: string;
  shortname: string;
  stage: Stage;
  champion?: string;
  closedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
  project?: string;
  issueUrl?: string;
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
  project?: string;
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
  meetings?: Meeting[];
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
  project?: string;
  issueUrl?: string;
  prUrl?: string;
  wgDiscussionUrl?: string;
  rfcDocUrl?: string;
  nextStage?: boolean;
  related?: string[];
  events: Event[];
  updatedAt: string;
  description: string;
}

export interface MeetingSource {
  href: string;
  content: string;
  section?: string;
}

export interface Meeting {
  id: string;
  group: string;
  date: string;
  cancelled: boolean;
  agenda: MeetingSource;
  notes: MeetingSource[];
  references: { identifier: string; agenda?: boolean; section?: string }[];
}
