import { describe, expect, it } from 'vitest';
import {
  validateArtifactLocator,
  resolveArtifactLocator,
  type ArtifactLocator,
} from '../services/mission/research/artifact-locator.js';

/**
 * VAL-RES-026: Citation artifact locator integrity.
 *
 * Each citation must resolve to the exact artifact version and a valid JSON
 * pointer or block/range where its inline mark appears. A locator targeting
 * another version or an absent block must be rejected.
 */

const DOC = {
  schemaVersion: 1,
  blocks: [
    { type: 'heading', level: 1, spans: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      spans: [
        { type: 'text', text: 'Claim ' },
        { type: 'citation', citationId: 'cit-1' },
      ],
    },
    {
      type: 'paragraph',
      spans: [{ type: 'text', text: 'Second paragraph with no citation.' }],
    },
  ],
};

describe('VAL-RES-026: validateArtifactLocator', () => {
  it('accepts a locator with the correct artifactVersion and a valid jsonPointer', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      jsonPointer: '/blocks/1/spans/1',
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a locator targeting a different artifact version', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 2,
      jsonPointer: '/blocks/1/spans/1',
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/version|mismatch/i);
  });

  it('rejects a jsonPointer that does not point at a citation span', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      jsonPointer: '/blocks/1/spans/0',
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not.*citation|citation.*span|point/i);
  });

  it('rejects a jsonPointer targeting an absent path', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      jsonPointer: '/blocks/9/spans/0',
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/absent|not found|resolve|pointer/i);
  });

  it('rejects a malformed jsonPointer', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      jsonPointer: 'blocks/1',
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/pointer|malformed|format/i);
  });

  it('accepts a blockId-based locator that names a block containing a citation', () => {
    const docWithIds = {
      schemaVersion: 1,
      blocks: [
        {
          type: 'paragraph',
          blockId: 'p1',
          spans: [
            { type: 'text', text: 'a ' },
            { type: 'citation', citationId: 'cit-2' },
          ],
        },
      ],
    };
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      blockId: 'p1',
    };
    const r = validateArtifactLocator(loc, 3, docWithIds);
    expect(r.valid).toBe(true);
  });

  it('rejects a blockId-based locator naming an absent block', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      blockId: 'nope',
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/absent|blockId|not found/i);
  });

  it('rejects a blockId-based locator naming a block without a citation', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      blockId: 'p2',
    };
    const docWithIds = {
      schemaVersion: 1,
      blocks: [
        {
          type: 'paragraph',
          blockId: 'p2',
          spans: [{ type: 'text', text: 'no citation here' }],
        },
      ],
    };
    const r = validateArtifactLocator(loc, 3, docWithIds);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/citation|not.*contain/i);
  });

  it('rejects a locator with neither jsonPointer nor blockId', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/jsonPointer.*blockId|required|either/i);
  });

  it('rejects a range locator whose start/end do not bound the citation span', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      jsonPointer: '/blocks/1/spans',
      start: 0,
      end: 0,
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
  });

  it('rejects a jsonPointer targeting unsafe prototype-pollution keys', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      jsonPointer: '/__proto__/spans/1',
    };
    const r = validateArtifactLocator(loc, 3, DOC);
    expect(r.valid).toBe(false);
  });
});

describe('VAL-RES-026: resolveArtifactLocator', () => {
  it('resolves a valid jsonPointer to the targeted citation span', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 3,
      jsonPointer: '/blocks/1/spans/1',
    };
    const resolved = resolveArtifactLocator(loc, 3, DOC);
    expect(resolved).not.toBeNull();
    expect(resolved).toMatchObject({ type: 'citation', citationId: 'cit-1' });
  });

  it('returns null for an invalid locator', () => {
    const loc: ArtifactLocator = {
      artifactVersion: 2,
      jsonPointer: '/blocks/1/spans/1',
    };
    expect(resolveArtifactLocator(loc, 3, DOC)).toBeNull();
  });
});
