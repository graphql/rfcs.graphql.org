import type { Meeting } from "./types.ts";

export const workingGroups = {
  graphiql: "GraphiQL",
  "ai-wg": "AI WG",
  "community-wg": "Community WG",
  "composite-schemas-wg": "Composite Schemas WG",
  "defer-stream-wg": "Incremental Delivery WG",
  "golden-path-wg": "Golden Path WG",
  "graphql-js-wg": "GraphQL.js WG",
  "graphql-over-http": "GraphQL over HTTP WG",
  "graphql-wg": "GraphQL WG",
  "nullability-wg": "Nullability WG",
  "otel-wg": "OpenTelemetry WG",
} as const;

export type WorkingGroup = keyof typeof workingGroups;
const meetingDirectories: Partial<
  Record<WorkingGroup, { agendas: string; notes: string }>
> = {
  "graphql-over-http": {
    agendas: "working-group/agendas",
    notes: "working-group/notes",
  },
  graphiql: {
    agendas: "working-group/agendas",
    notes: "working-group/minutes",
  },
};
export const meetingPaths = (group: WorkingGroup) =>
  meetingDirectories[group] ?? { agendas: "agendas", notes: "notes" };

export const groupIds = Object.keys(workingGroups) as WorkingGroup[];
export const groupName = (group: string) =>
  workingGroups[group as WorkingGroup] ?? group;
export const meetingHref = (meeting: Meeting) =>
  `/meetings/${meeting.group}/${meeting.id}/`;
export const meetingStatus = (meeting: Meeting) =>
  meeting.cancelled
    ? "Cancelled"
    : meeting.notes.length
      ? "Notes available"
      : "Notes pending";
