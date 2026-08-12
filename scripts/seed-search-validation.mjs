#!/usr/bin/env node
// Seed search validation fixture for M1 user-testing re-run.
// Uses the live API (localhost:3110) + direct DB for bulk insert and date manipulation.
import { readFileSync } from 'node:fs';

const API = 'http://localhost:3110';
const MISSION_DIR = '/Users/mgunnin/.factory/missions/f607c5ad-2305-47d2-be80-33811d9b7ffc';
const envFile = readFileSync('/Users/mgunnin/Developer/06_Projects/Eidolon/.env', 'utf-8');
const DB_URL = envFile.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function postId(path, body, headers) {
  const r = await api('POST', path, body, headers);
  return r.data.id;
}

async function main() {
  console.log('=== Creating companies ===');
  const cid1 = await postId('/api/companies', { name: '__mtest__ Search Validation', settings: { testFixture: true } });
  const cid2 = await postId('/api/companies', { name: '__mtest__ Other Search Corp', settings: { testFixture: true } });
  console.log(`CID1=${cid1}  CID2=${cid2}`);

  console.log('=== Project + folders ===');
  const pid = await postId(`/api/companies/${cid1}/projects`, { name: 'Search Proj', status: 'active' });
  const fa = await postId(`/api/companies/${cid1}/folders`, { name: 'Search Folder A', projectId: pid });
  const fb = await postId(`/api/companies/${cid1}/folders`, { name: 'Search Folder B', projectId: pid });
  console.log(`PID=${pid}  FA=${fa}  FB=${fb}`);

  // Content helpers
  const doc = (body) => ({ format: 'markdown', body });
  const sheet = (val) => ({ columns: [{ id: 'col1', key: 'name' }], rows: [{ id: 'row1', cells: { name: { value: val } } }] });
  const board = (title) => ({ columns: [{ id: 'col1', title: 'Todo' }], cards: [{ id: 'card1', columnId: 'col1', title, order: 0 }] });
  const slide = (text) => ({ slides: [{ id: 'slide1', layout: 'title', blocks: [{ type: 'text', content: { text } }] }] });
  const timeline = (title) => ({ tasks: [{ id: 'task1', title, start: '2025-01-01', end: '2025-02-01' }] });
  const gallery = (caption) => ({ items: [{ id: 'item1', type: 'image', url: 'https://example.com/img.png', caption }] });
  const dashboard = (title) => ({ dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: {} } }], widgets: [{ id: 'w1', type: 'metric', dataSourceId: 'ds1', config: { title } }] });
  const app = (content) => ({ definition: { name: 'Demo App' }, files: [{ path: 'index.html', content }] });
  const code = (content) => ({ language: 'javascript', files: [{ path: 'main.js', content }] });

  async function mkArt(type, title, content, opts = {}) {
    const body = { type, title, content };
    if (opts.projectId !== undefined) body.projectId = opts.projectId;
    if (opts.folderId !== undefined) body.folderId = opts.folderId;
    const headers = {};
    if (opts.userId) headers['X-Eidolon-Test-User-Id'] = opts.userId;
    return postId(`/api/companies/${opts.cid || cid1}/artifacts`, body, headers);
  }

  console.log('=== Per-type extraction artifacts ===');
  const ids = {};
  ids.doc_resilience = await mkArt('document', 'Generic Title', doc('This document discusses resilience strategies for distributed systems'), { projectId: pid });
  ids.sheet_forecast = await mkArt('sheet', 'Generic Sheet Title', sheet('Q3 forecast data'), { projectId: pid });
  ids.board_onboarding = await mkArt('board', 'Generic Board Title', board('Onboarding checklist'), { projectId: pid });
  ids.slide_roadmap = await mkArt('slide_deck', 'Generic Deck Title', slide('Product roadmap details'), { projectId: pid });
  ids.timeline_migration = await mkArt('timeline', 'Generic Timeline Title', timeline('Database migration'), { projectId: pid });
  ids.gallery_sunset = await mkArt('gallery', 'Generic Gallery Title', gallery('Sunset over the ocean'), { projectId: pid });
  ids.dashboard_retention = await mkArt('dashboard', 'Generic Dashboard Title', dashboard('User retention metrics'), { projectId: pid });
  ids.app_handleauth = await mkArt('app', 'Generic App Title', app('function handleAuth() { return true; }'), { projectId: pid });
  ids.code_parseconfig = await mkArt('code', 'Generic Code Title', code('function parseConfig() { return {}; }'), { projectId: pid });
  console.log('9 per-type artifacts done');

  console.log('=== Budget ranking ===');
  ids.doc_budget_title = await mkArt('document', 'Budget Report', doc('Financial analysis overview'), { projectId: pid });
  ids.doc_budget_content = await mkArt('document', 'Financial Analysis', doc('The budget allocation for Q4 includes forecast data'), { projectId: pid });

  console.log('=== Filter fixtures ===');
  ids.doc_report = await mkArt('document', 'ReportDoc', doc('searchterm report content'), { projectId: pid });
  ids.sheet_report = await mkArt('sheet', 'ReportSheet', sheet('searchterm report'), { projectId: pid });
  ids.doc_folder_a = await mkArt('document', 'FolderDocA', doc('searchterm in folder A'), { projectId: pid, folderId: fa });
  ids.doc_folder_b = await mkArt('document', 'FolderDocB', doc('searchterm in folder B'), { projectId: pid, folderId: fb });
  ids.doc_author_a = await mkArt('document', 'AuthorDocA', doc('searchterm by author A'), { projectId: pid, userId: 'user-author-a' });
  ids.doc_author_b = await mkArt('document', 'AuthorDocB', doc('searchterm by author B'), { projectId: pid, userId: 'user-author-b' });

  console.log('=== Date fixtures ===');
  ids.doc_old = await mkArt('document', 'OldDoc', doc('searchterm old content'), { projectId: pid });
  ids.doc_recent = await mkArt('document', 'RecentDoc', doc('searchterm recent content'), { projectId: pid });

  console.log('=== Combined filter fixture ===');
  ids.doc_combined = await mkArt('document', 'MatchDoc', doc('searchterm combined content'), { projectId: pid, folderId: fa, userId: 'user-combined-a' });
  const wrongType = await mkArt('sheet', 'WrongType', sheet('searchterm'), { projectId: pid, folderId: fa, userId: 'user-combined-a' });
  const wrongFolder = await mkArt('document', 'WrongFolder', doc('searchterm content'), { projectId: pid, folderId: fb, userId: 'user-combined-a' });
  const wrongAuthor = await mkArt('document', 'WrongAuthor', doc('searchterm content'), { projectId: pid, folderId: fa, userId: 'user-combined-b' });
  const wrongDate = await mkArt('document', 'WrongDate', doc('searchterm content'), { projectId: pid, folderId: fa, userId: 'user-combined-a' });

  console.log('=== Archived/deleted ===');
  ids.doc_archived = await mkArt('document', 'LegacyArchived', doc('legacy content archived'), { projectId: pid });
  await api('POST', `/api/companies/${cid1}/artifacts/${ids.doc_archived}/archive`);
  ids.doc_legacy_active = await mkArt('document', 'LegacyDoc', doc('legacy content active'), { projectId: pid });
  ids.doc_deleted = await mkArt('document', 'ObsoleteDeleted', doc('obsolete content deleted'), { projectId: pid });
  ids.doc_obsolete_active = await mkArt('document', 'ObsoleteDoc', doc('obsolete content active'), { projectId: pid });

  console.log('=== Scoping ===');
  ids.doc_scoped_c1 = await mkArt('document', 'ScopedDoc', doc('scoped content company 1'), { projectId: pid });
  ids.doc_scoped_c2 = await mkArt('document', 'ScopedDoc', doc('scoped content company 2'), { cid: cid2, projectId: null });

  console.log('=== Threads + items ===');
  const t1 = await postId(`/api/companies/${cid1}/projects/${pid}/threads`, { title: 'Discussion Thread' });
  const t1i = await postId(`/api/companies/${cid1}/projects/${pid}/threads/${t1}/items`, { kind: 'comment', content: 'Discussing the launch plan for Q3' });
  const t2 = await postId(`/api/companies/${cid1}/projects/${pid}/threads`, { title: 'Launch Planning' });
  const t2i = await postId(`/api/companies/${cid1}/projects/${pid}/threads/${t2}/items`, { kind: 'comment', content: 'Talking about the launch plan again' });

  console.log('=== Tasks ===');
  const task1 = await postId(`/api/companies/${cid1}/tasks`, { title: 'Migration cutover', description: 'Execute the database migration cutover plan', status: 'backlog' });
  const task2 = await postId(`/api/companies/${cid1}/tasks`, { title: 'About Q3 launch', description: 'Plan the Q3 product launch', status: 'backlog' });

  console.log('=== Setting dates via SQL ===');
  const { execSync } = await import('node:child_process');
  const sqlSet = (aid, date) => execSync(`psql "${DB_URL}" -c "UPDATE artifacts SET updated_at = '${date}' WHERE id = '${aid}';" -t 2>/dev/null`, { stdio: 'pipe' });
  const sqlDelete = (aid) => execSync(`psql "${DB_URL}" -c "UPDATE artifacts SET status='deleted', deleted_at=NOW() WHERE id='${aid}';" -t 2>/dev/null`, { stdio: 'pipe' });
  sqlSet(ids.doc_old, '2024-06-15T00:00:00Z');
  sqlSet(ids.doc_recent, '2025-06-15T00:00:00Z');
  sqlSet(ids.doc_combined, '2025-03-15T00:00:00Z');
  sqlSet(wrongType, '2025-03-15T00:00:00Z');
  sqlSet(wrongFolder, '2025-03-15T00:00:00Z');
  sqlSet(wrongAuthor, '2025-03-15T00:00:00Z');
  sqlSet(wrongDate, '2024-01-15T00:00:00Z');
  sqlDelete(ids.doc_deleted);
  console.log('Dates set');

  console.log('=== Bulk insert 1050 Budget Report artifacts ===');
  const bulkSQL = `
INSERT INTO artifacts (id, company_id, type, title, content, status, version, search_text, search_tsv, created_at, updated_at)
SELECT
  gen_random_uuid(),
  '${cid1}',
  'document',
  'Budget Report ' || i,
  jsonb_build_object('format', 'markdown', 'body', 'quarterly budget forecast report ' || i),
  'active', 1,
  'Budget Report ' || i || ' quarterly budget forecast report ' || i,
  setweight(to_tsvector('english', 'Budget Report ' || i), 'A') ||
  setweight(to_tsvector('english', 'quarterly budget forecast report ' || i), 'B'),
  NOW() - (i || ' minutes')::interval,
  NOW() - (i || ' minutes')::interval
FROM generate_series(1, 1050) AS i;`;
  execSync(`psql "${DB_URL}" -t`, { input: bulkSQL, stdio: ['pipe', 'pipe', 'pipe'] });
  console.log('Bulk insert done');

  console.log('=== Verify ===');
  const budgetRes = await api('GET', `/api/companies/${cid1}/search?q=budget`);
  console.log(`q=budget total: ${budgetRes.total}`);
  const dateRes = await fetch(`${API}/api/companies/${cid1}/search?q=searchterm&dateFrom=2025-01-01`);
  console.log(`q=searchterm&dateFrom HTTP: ${dateRes.status}`);
  const stRes = await api('GET', `/api/companies/${cid1}/search?q=searchterm`);
  console.log(`q=searchterm total: ${stRes.total}`);

  console.log('=== Write fixture-ids.json ===');
  const fixture = {
    company: { id: cid1, name: '__mtest__ Search Validation' },
    company2: { id: cid2, name: '__mtest__ Other Search Corp' },
    project: { id: pid },
    folder: { id: fa, name: 'Search Folder A' },
    folder2: { id: fb, name: 'Search Folder B' },
    artifacts: ids,
    threads: {
      thread1: { id: t1, itemId: t1i },
      thread2: { id: t2, itemId: t2i },
    },
    tasks: { task1, task2 },
    users: {
      author_a: 'user-author-a',
      author_b: 'user-author-b',
      combined_a: 'user-combined-a',
      combined_b: 'user-combined-b',
    },
  };
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const outPath = `${MISSION_DIR}/validation/m1-search/user-testing/fixture-ids.json`;
  mkdirSync(`${MISSION_DIR}/validation/m1-search/user-testing`, { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`fixture-ids.json written to ${outPath}`);
  console.log('=== DONE ===');
}

main().catch(e => { console.error(e); process.exit(1); });
