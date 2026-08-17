import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const schemaOwnershipPath = resolve(root, 'docs/architecture/schema-ownership.md');
const runbookIndexPath = resolve(root, 'docs/runbooks/README.md');
const observabilityPath = resolve(root, 'docs/runbooks/observability.md');
const dbPackagePath = resolve(root, 'packages/db/package.json');
const serverPackagePath = resolve(root, 'server/package.json');
const uiPackagePath = resolve(root, 'ui/package.json');
const mcpServerPackagePath = resolve(root, 'packages/mcp-server/package.json');
const desktopPackagePath = resolve(root, 'packages/desktop/package.json');

describe('database schema ownership documentation', () => {
  it('exists at docs/architecture/schema-ownership.md', () => {
    expect(existsSync(schemaOwnershipPath)).toBe(true);
  });

  it('documents that the server is the sole schema owner', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toMatch(/server.*sole.*owner/i);
  });

  it('states that the UI does not own a schema', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toMatch(/UI.*No/i);
  });

  it('states that the desktop app does not own a schema', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toMatch(/Desktop.*No/i);
  });

  it('states that the MCP server does not own a schema', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toMatch(/MCP server.*No/i);
  });

  it('documents the migration workflow', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toMatch(/migration workflow/i);
    expect(content).toMatch(/pnpm db:generate/);
    expect(content).toMatch(/pnpm db:migrate/);
  });

  it('documents Drizzle ORM as the schema management tool', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toMatch(/Drizzle ORM/);
  });

  it('documents where the schema definitions live', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toContain('packages/db/src/schema/');
  });

  it('documents where generated migrations live', () => {
    const content = readFileSync(schemaOwnershipPath, 'utf8');
    expect(content).toContain('packages/db/drizzle/');
  });
});

describe('schema ownership linked from runbook index', () => {
  it('docs/runbooks/README.md links to schema-ownership.md', () => {
    const content = readFileSync(runbookIndexPath, 'utf8');
    expect(content).toContain('schema-ownership.md');
  });

  it('docs/runbooks/observability.md references schema ownership', () => {
    const content = readFileSync(observabilityPath, 'utf8');
    expect(content).toContain('schema-ownership.md');
  });
});

describe('package-level schema ownership boundaries', () => {
  it('server package depends on @eidolon/db', () => {
    const content = readFileSync(serverPackagePath, 'utf8');
    expect(content).toContain('"@eidolon/db"');
  });

  it('db package depends on drizzle-orm', () => {
    const content = readFileSync(dbPackagePath, 'utf8');
    expect(content).toContain('drizzle-orm');
  });

  it('db package defines db:generate and db:migrate scripts', () => {
    const content = readFileSync(dbPackagePath, 'utf8');
    expect(content).toContain('"generate"');
    expect(content).toContain('"migrate"');
  });

  it('db package contains Drizzle schema files', () => {
    const schemaDir = resolve(root, 'packages/db/src/schema');
    expect(existsSync(schemaDir)).toBe(true);
    const files = readdirSync(schemaDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('ui package does not depend on drizzle or @eidolon/db', () => {
    const content = readFileSync(uiPackagePath, 'utf8');
    expect(content).not.toContain('drizzle');
    expect(content).not.toContain('@eidolon/db');
  });

  it('mcp-server package does not depend on drizzle or @eidolon/db', () => {
    const content = readFileSync(mcpServerPackagePath, 'utf8');
    expect(content).not.toContain('drizzle');
    expect(content).not.toContain('@eidolon/db');
  });

  it('desktop package does not depend on drizzle or @eidolon/db', () => {
    const content = readFileSync(desktopPackagePath, 'utf8');
    expect(content).not.toContain('drizzle');
    expect(content).not.toContain('@eidolon/db');
  });
});
