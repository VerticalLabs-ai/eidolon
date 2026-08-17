/** Type declarations for sentry-dispatch.mjs — mirrors the JSDoc annotations in the script. */

export interface SentryIssueData {
  shortId: string;
  title: string;
  url: string;
}

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

export interface RequiredLabel {
  name: string;
  color: string;
  description: string;
}

export type DispatchResult =
  | { ok: true; action: 'created'; draft: IssueDraft; shortId: string }
  | { ok: true; action: 'deduplicated'; shortId: string }
  | { ok: false; reason: string };

export const REQUIRED_LABELS: RequiredLabel[];

export function parseSentryPayload(raw: unknown): SentryIssueData | null;

export function createIssueTitle(data: SentryIssueData): string;

export function createIssueBody(data: SentryIssueData): string;

export function findDuplicate(
  existingIssues: Array<{ body?: string | null }>,
  sentryId: string,
): boolean;

export function buildIssueDraft(data: SentryIssueData): IssueDraft;

export function processDispatch(
  payload: unknown,
  existingOpenIssues: Array<{ body?: string | null }>,
): DispatchResult;
