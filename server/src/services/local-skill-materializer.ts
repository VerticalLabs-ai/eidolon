import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DbInstance } from '../types.js';
import type { LocalCliRuntimePaths } from './local-cli-adapter.js';

const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface MaterializeLocalAgentSkillsInput {
  db: DbInstance;
  companyId: string;
  agentId: string;
  runtimePaths: LocalCliRuntimePaths;
}

function skillDocument(input: {
  name: string;
  content: string;
  metadata: Record<string, unknown>;
}): string {
  const configuredDescription = input.metadata.description;
  const description = typeof configuredDescription === 'string' && configuredDescription.trim()
    ? configuredDescription.trim()
    : `Eidolon company skill: ${input.name}`;
  return [
    '---',
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    input.content.trimEnd(),
    '',
  ].join('\n');
}

async function assertRealDirectory(directory: string, label: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function ensureRealDirectory(directory: string, label: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertRealDirectory(directory, label);
}

async function prepareSkillsRoot(runtimePaths: LocalCliRuntimePaths): Promise<string> {
  await fs.mkdir(runtimePaths.adapterRuntimeHome, { recursive: true, mode: 0o700 });
  await assertRealDirectory(runtimePaths.adapterRuntimeHome, 'Local adapter runtime home');
  const nativeHome = runtimePaths.codexHome ?? path.join(runtimePaths.adapterRuntimeHome, '.claude');
  await ensureRealDirectory(nativeHome, 'Native CLI home');
  await ensureRealDirectory(runtimePaths.skillsRoot, 'Local skill root');
  return fs.realpath(runtimePaths.skillsRoot);
}

async function writeSkillDocument(
  skillsRoot: string,
  skillName: string,
  document: string,
): Promise<string> {
  const skillDirectory = path.join(skillsRoot, skillName);
  const relativeDirectory = path.relative(skillsRoot, skillDirectory);
  if (
    !relativeDirectory ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    throw new Error(`Skill "${skillName}" resolves outside the local skill root.`);
  }

  try {
    await fs.mkdir(skillDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertRealDirectory(skillDirectory, `Skill directory for "${skillName}"`);

  const target = path.join(skillDirectory, 'SKILL.md');
  try {
    const targetStats = await fs.lstat(target);
    if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
      throw new Error(`Skill file for "${skillName}" must be a regular file.`);
    }
    if (await fs.readFile(target, 'utf8') === document) return skillDirectory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = path.join(skillDirectory, `.SKILL.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return skillDirectory;
}

export async function materializeLocalAgentSkills(
  input: MaterializeLocalAgentSkillsInput,
): Promise<void> {
  const { agentSkills, companySkills } = input.db.schema;
  const rows = await input.db.drizzle
    .select({ assignment: agentSkills, skill: companySkills })
    .from(agentSkills)
    .innerJoin(
      companySkills,
      and(
        eq(companySkills.id, agentSkills.skillId),
        eq(companySkills.companyId, input.companyId),
      ),
    )
    .where(
      and(
        eq(agentSkills.companyId, input.companyId),
        eq(agentSkills.agentId, input.agentId),
      ),
    );
  const activeRows = rows.filter(({ assignment }) => assignment.syncStatus !== 'disabled');
  if (activeRows.length === 0) return;

  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const { skill } of activeRows) {
    if (seenNames.has(skill.name)) duplicateNames.add(skill.name);
    seenNames.add(skill.name);
  }

  const validationFailures = activeRows.filter(({ skill }) =>
    !SAFE_SKILL_NAME.test(skill.name) ||
    skill.name.length > 64 ||
    skill.trustLevel !== 'markdown_only' ||
    duplicateNames.has(skill.name),
  );
  if (validationFailures.length > 0) {
    const now = new Date();
    for (const { assignment } of validationFailures) {
      await input.db.drizzle
        .update(agentSkills)
        .set({ syncStatus: 'failed', materializedPath: null, updatedAt: now })
        .where(eq(agentSkills.id, assignment.id));
    }
    const { skill } = validationFailures[0];
    const reason = duplicateNames.has(skill.name)
      ? 'multiple assigned versions share this name'
      : skill.trustLevel !== 'markdown_only'
        ? `trust level "${skill.trustLevel}" is not supported by local runtimes`
        : 'name must contain only lowercase letters, numbers, and single hyphens (maximum 64 characters)';
    throw new Error(`Cannot materialize company skill "${skill.name}": ${reason}.`);
  }

  let skillsRoot: string;
  try {
    skillsRoot = await prepareSkillsRoot(input.runtimePaths);
  } catch (error) {
    const now = new Date();
    for (const { assignment } of activeRows) {
      await input.db.drizzle
        .update(agentSkills)
        .set({ syncStatus: 'failed', materializedPath: null, updatedAt: now })
        .where(eq(agentSkills.id, assignment.id));
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare local skill root: ${message}`);
  }
  for (const { assignment, skill } of activeRows) {
    try {
      const materializedPath = await writeSkillDocument(
        skillsRoot,
        skill.name,
        skillDocument({ name: skill.name, content: skill.content, metadata: skill.metadata }),
      );
      const now = new Date();
      await input.db.drizzle
        .update(agentSkills)
        .set({
          syncStatus: 'synced',
          materializedPath,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(agentSkills.id, assignment.id));
    } catch (error) {
      await input.db.drizzle
        .update(agentSkills)
        .set({ syncStatus: 'failed', materializedPath: null, updatedAt: new Date() })
        .where(eq(agentSkills.id, assignment.id));
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to materialize company skill "${skill.name}": ${message}`);
    }
  }
}
