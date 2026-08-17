import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM tooling script without type declarations
import { renderMarkdown, summarize } from '../../../scripts/summarize-sarif.mjs';
// @ts-expect-error - plain ESM tooling script without type declarations
import { validateTarget } from '../../../scripts/validate-dast-target.mjs';

type Sarif = Record<string, unknown>;

function sarif(results: unknown[], rules: unknown[] = []): Sarif {
  return {
    runs: [
      {
        tool: { driver: { name: 'CodeQL', rules } },
        results,
      },
    ],
  };
}

describe('CodeQL SARIF summary', () => {
  it('states a clean scan explicitly instead of rendering an empty report', () => {
    const markdown = renderMarkdown(summarize([sarif([])]), { scannedFiles: 1 });

    expect(markdown).toContain('**No findings.**');
    expect(markdown).toContain('explicit clean result, not a skipped step');
    expect(markdown).not.toContain('By severity');
  });

  it('groups findings by severity and rule with example locations', () => {
    const rules = [
      {
        id: 'js/sql-injection',
        name: 'SQL injection',
        shortDescription: { text: 'Database query built from user input' },
        properties: { 'security-severity': '9.8' },
      },
      {
        id: 'js/unused-local',
        shortDescription: { text: 'Unused local variable' },
        defaultConfiguration: { level: 'note' },
      },
    ];
    const results = [
      {
        ruleId: 'js/sql-injection',
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: 'server/src/routes/tasks.ts' },
              region: { startLine: 42 },
            },
          },
        ],
      },
      {
        ruleId: 'js/sql-injection',
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: 'server/src/routes/agents.ts' },
              region: { startLine: 7 },
            },
          },
        ],
      },
      { ruleId: 'js/unused-local', locations: [] },
    ];

    const summary = summarize([sarif(results, rules)]);
    expect(summary.total).toBe(3);
    // security-severity 9.8 outranks the coarse SARIF level.
    expect(summary.counts).toEqual({ critical: 2, note: 1 });

    const markdown = renderMarkdown(summary, { scannedFiles: 1 });
    expect(markdown).toContain('| critical | 2 |');
    expect(markdown).toContain('server/src/routes/tasks.ts:42');
    expect(markdown).toContain('js/unused-local');
    // Critical must be listed before note.
    expect(markdown.indexOf('js/sql-injection')).toBeLessThan(markdown.indexOf('js/unused-local'));
  });

  it('merges multiple SARIF files and caps the locations it lists', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ruleId: 'js/path-injection',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: `server/src/file-${index}.ts` },
            region: { startLine: index + 1 },
          },
        },
      ],
    }));

    const summary = summarize([sarif(many.slice(0, 4)), sarif(many.slice(4))]);
    expect(summary.total).toBe(9);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].locations).toHaveLength(5);

    const markdown = renderMarkdown(summary, { scannedFiles: 2 });
    expect(markdown).toContain('(+4 more)');
  });

  it('falls back to a usable label when a result has no matching rule', () => {
    const summary = summarize([sarif([{ ruleId: 'js/unknown', level: 'error' }])]);

    expect(summary.counts).toEqual({ error: 1 });
    expect(summary.entries[0].title).toBe('js/unknown');
  });
});

describe('DAST target validation', () => {
  it('treats an unset target as unconfigured rather than invalid', () => {
    for (const value of [undefined, '', '   ']) {
      const result = validateTarget(value);
      expect(result).toMatchObject({ ok: true, configured: false });
    }
  });

  it('requires HTTPS', () => {
    const result = validateTarget('http://staging.example.test');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('HTTPS');
  });

  it('refuses production however the hostname is written', () => {
    const targets = [
      'https://eidolon.verticallabs.ai',
      'https://eidolon.verticallabs.ai/',
      'https://eidolon.verticallabs.ai/login?next=/x',
      'https://EIDOLON.VerticalLabs.ai',
      'https://eidolon.verticallabs.ai:443/',
      'https://eidolon.verticallabs.ai./',
      'https://www.eidolon.verticallabs.ai',
    ];

    for (const target of targets) {
      const result = validateTarget(target);
      expect(result.ok, `expected refusal for ${target}`).toBe(false);
      expect(result.reason).toContain('production hostname');
    }
  });

  it('refuses a target carrying credentials', () => {
    const result = validateTarget(
      ['https://', 'user', ':', 'pass', '@staging.example.test'].join(''),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('credentials');
    // The refusal must not echo the credential back into a log.
    expect(result.reason).not.toContain('secret');
  });

  it('refuses a value that is not a URL', () => {
    const result = validateTarget('staging.example.test');
    expect(validateTarget('not a url').ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('accepts a non-production HTTPS target', () => {
    const result = validateTarget('https://eidolon-staging.vercel.app/');
    expect(result).toMatchObject({ ok: true, configured: true });
    expect(result.target).toBe('https://eidolon-staging.vercel.app/');
  });
});
