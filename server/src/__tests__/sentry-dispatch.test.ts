import { describe, expect, it } from 'vitest';
import {
  buildIssueDraft,
  createIssueBody,
  createIssueTitle,
  findDuplicate,
  parseSentryPayload,
  processDispatch,
  REQUIRED_LABELS,
} from '../../../scripts/sentry-dispatch.mjs';

describe('sentry dispatch contract', () => {
  const wellFormedPayload = {
    issue: {
      shortId: 'PROJ-42',
      title: 'TypeError: Cannot read properties of undefined',
      web_url: 'https://sentry.example/organizations/proj/issues/42/',
    },
  };

  const payloadMissingUrl = {
    issue: {
      shortId: 'PROJ-43',
      title: 'DatabaseError: connection refused',
    },
  };

  const payloadMissingAllIssueFields = {
    data: {},
    shortId: '',
    title: '',
  };

  const payloadNotAnObject = 'not-json';

  describe('parseSentryPayload', () => {
    it('extracts shortId, title, and url from a well-formed payload', () => {
      const data = parseSentryPayload(wellFormedPayload);
      expect(data).toEqual({
        shortId: 'PROJ-42',
        title: 'TypeError: Cannot read properties of undefined',
        url: 'https://sentry.example/organizations/proj/issues/42/',
      });
    });

    it('handles a payload missing the url field', () => {
      const data = parseSentryPayload(payloadMissingUrl);
      expect(data).toEqual({
        shortId: 'PROJ-43',
        title: 'DatabaseError: connection refused',
        url: '',
      });
    });

    it('handles the data.issue wrapper variant', () => {
      const data = parseSentryPayload({
        data: { issue: { shortId: 'ID-1', title: 'Test', url: 'https://x' } },
      });
      expect(data?.shortId).toBe('ID-1');
    });

    it('handles top-level shortId/title fallbacks', () => {
      const data = parseSentryPayload({ shortId: 'TOP-1', title: 'Top-level' });
      expect(data?.shortId).toBe('TOP-1');
      expect(data?.title).toBe('Top-level');
    });

    it('returns null when required fields are missing', () => {
      expect(parseSentryPayload(payloadMissingAllIssueFields)).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(parseSentryPayload(payloadNotAnObject)).toBeNull();
      expect(parseSentryPayload(null)).toBeNull();
      expect(parseSentryPayload(undefined)).toBeNull();
    });

    it('truncates the title to 180 characters', () => {
      const longTitle = 'A'.repeat(300);
      const data = parseSentryPayload({ issue: { shortId: 'X', title: longTitle } });
      expect(data?.title.length).toBe(180);
    });
  });

  describe('findDuplicate', () => {
    it('finds an existing issue with the same Sentry ID', () => {
      const issues = [
        { body: 'Some issue\nSentry ID: PROJ-42\nMore text' },
        { body: 'Different issue\nSentry ID: PROJ-99' },
      ];
      expect(findDuplicate(issues, 'PROJ-42')).toBe(true);
    });

    it('returns false when no issue matches', () => {
      const issues = [{ body: 'Sentry ID: PROJ-99' }];
      expect(findDuplicate(issues, 'PROJ-42')).toBe(false);
    });

    it('handles null body', () => {
      expect(findDuplicate([{ body: null }], 'PROJ-42')).toBe(false);
    });
  });

  describe('createIssueBody', () => {
    it('includes the Sentry ID and link but no raw payload', () => {
      const body = createIssueBody({
        shortId: 'PROJ-42',
        title: 'Test',
        url: 'https://sentry.example/42',
      });
      expect(body).toContain('Sentry ID: PROJ-42');
      expect(body).toContain('Sentry link: https://sentry.example/42');
      // The body must not include the title or other payload fields.
      expect(body).not.toContain('Test');
    });

    it('omits the link line when url is empty', () => {
      const body = createIssueBody({ shortId: 'X', title: 'T', url: '' });
      expect(body).not.toContain('Sentry link');
    });
  });

  describe('processDispatch', () => {
    it('creates an issue draft from a well-formed payload', () => {
      const result = processDispatch(wellFormedPayload, []);
      expect(result.ok).toBe(true);
      if (result.ok && result.action === 'created') {
        expect(result.shortId).toBe('PROJ-42');
        expect(result.draft.title).toBe(
          'Sentry alert: TypeError: Cannot read properties of undefined',
        );
        expect(result.draft.labels).toEqual(['sentry', 'type/bug']);
        // The body must not contain raw payload field names or stack traces.
        expect(result.draft.body).not.toContain('web_url');
        expect(result.draft.body).not.toContain('shortId');
        // The Sentry link is intentionally included.
        expect(result.draft.body).toContain('Sentry link:');
      }
    });

    it('creates an issue from a payload missing optional fields', () => {
      const result = processDispatch(payloadMissingUrl, []);
      expect(result.ok).toBe(true);
      if (result.ok && result.action === 'created') {
        expect(result.shortId).toBe('PROJ-43');
        expect(result.draft.body).toContain('Sentry ID: PROJ-43');
        expect(result.draft.body).not.toContain('Sentry link');
      }
    });

    it('deduplicates when an open issue already tracks the same Sentry ID', () => {
      const existing = [{ body: 'Sentry ID: PROJ-42\nold issue' }];
      const result = processDispatch(wellFormedPayload, existing);
      expect(result.ok).toBe(true);
      if (result.ok && result.action === 'deduplicated') {
        expect(result.shortId).toBe('PROJ-42');
      }
    });

    it('refuses a payload missing required fields', () => {
      const result = processDispatch(payloadMissingAllIssueFields, []);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('missing required');
      }
    });

    it('refuses a malformed payload', () => {
      expect(processDispatch('garbage', []).ok).toBe(false);
      expect(processDispatch(null, []).ok).toBe(false);
      expect(processDispatch({}, []).ok).toBe(false);
    });

    it('creates a new issue when the existing one has a different Sentry ID', () => {
      const existing = [{ body: 'Sentry ID: PROJ-99' }];
      const result = processDispatch(wellFormedPayload, existing);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe('created');
      }
    });
  });

  describe('REQUIRED_LABELS', () => {
    it('declares sentry and type/bug with colors matching labels.json', () => {
      const names = REQUIRED_LABELS.map((l) => l.name);
      expect(names).toEqual(['sentry', 'type/bug']);
      for (const label of REQUIRED_LABELS) {
        expect(label.color).toMatch(/^[0-9a-f]{6}$/);
        expect(label.description.length).toBeGreaterThan(10);
      }
    });
  });
});
