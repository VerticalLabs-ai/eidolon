#!/usr/bin/env node
// Seed cross-integration validation fixture.
// Creates a __mtest__ company with artifacts that have:
//  - Searchable content (for M1 search)
//  - Multiple revisions (for M2 diff)
//  - Thread items with @-mentions (for M3 links)
// This enables end-to-end cross-feature flow testing (VAL-CROSS-001..010).
import { writeFileSync, mkdirSync } from 'node:fs';

const API = 'http://localhost:3110';
const MISSION_DIR = '/Users/mgunnin/.factory/missions/f607c5ad-2305-47d2-be80-33811d9b7ffc';

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 800)}`);
  }
  return JSON.parse(text);
}

async function postId(path, body, headers) {
  const r = await api('POST', path, body, headers);
  return r.data.id;
}

async function patchId(path, body, headers) {
  const r = await api('PATCH', path, body, headers);
  return r.data;
}

function docContent(title, body) {
  return { format: 'markdown', body: body || `# ${title}\n\nInitial content for ${title}.` };
}

function artMention(aid, artifactType = 'document') {
  return { entityType: 'artifact', entityId: aid, label: 'artifact', artifactType };
}

async function main() {
  console.log('=== Creating cross-integration validation company ===');
  const cid = await postId('/api/companies', {
    name: '__mtest__ Cross Integration',
    settings: { testFixture: true },
  });
  console.log(`CID=${cid}`);

  console.log('=== Creating project ===');
  const pid = await postId(`/api/companies/${cid}/projects`, {
    name: 'Cross Proj',
    status: 'active',
  });
  console.log(`PID=${pid}`);

  console.log('=== Creating folder ===');
  const folderId = await postId(`/api/companies/${cid}/folders`, {
    name: 'Cross Folder',
    projectId: pid,
  });
  console.log(`FOLDER=${folderId}`);

  console.log('=== Creating agent ===');
  const agentId = await postId(`/api/companies/${cid}/agents`, {
    name: 'Cross Agent',
    role: 'engineer',
    provider: 'anthropic',
  });
  console.log(`AGENT=${agentId}`);

  // ── Main artifact: searchable title + multiple revisions + mentioned in threads ──
  console.log('=== Creating main artifact (cross_main) with 3 revisions ===');
  const mainId = await postId(`/api/companies/${cid}/artifacts`, {
    type: 'document',
    title: 'Cross Main Budget Plan',
    content: docContent('Cross Main Budget Plan', '# Cross Main Budget Plan\n\n## Overview\nThe budget plan covers Q3 and Q4.\n\n## Details\nInitial draft with placeholder numbers.'),
    projectId: pid,
    folderId,
  }, { 'X-Eidolon-Agent-Id': agentId });
  console.log(`cross_main=${mainId} (v1)`);

  // Revision 2: add a line
  await patchId(`/api/companies/${cid}/artifacts/${mainId}`, {
    version: 1,
    title: 'Cross Main Budget Plan',
    content: docContent('Cross Main Budget Plan', '# Cross Main Budget Plan\n\n## Overview\nThe budget plan covers Q3 and Q4.\n\n## Details\nInitial draft with placeholder numbers.\n\n## Q3 Forecast\nRevenue projection: $2.5M'),
  }, { 'X-Eidolon-Agent-Id': agentId });
  console.log(`cross_main v2 created`);

  // Revision 3: modify a line + add more
  await patchId(`/api/companies/${cid}/artifacts/${mainId}`, {
    version: 2,
    title: 'Cross Main Budget Plan',
    content: docContent('Cross Main Budget Plan', '# Cross Main Budget Plan\n\n## Overview\nThe budget plan covers Q3 and Q4 2025.\n\n## Details\nInitial draft with placeholder numbers.\n\n## Q3 Forecast\nRevenue projection: $2.5M\n\n## Q4 Forecast\nRevenue projection: $3.0M\n\n## Risks\nMarket volatility may impact Q4.'),
  }, { 'X-Eidolon-Agent-Id': agentId });
  console.log(`cross_main v3 created`);

  // ── Related artifact: same project + folder + agent → score 7, also searchable ──
  console.log('=== Creating related artifact (cross_related) with 2 revisions ===');
  const relatedId = await postId(`/api/companies/${cid}/artifacts`, {
    type: 'document',
    title: 'Cross Related Roadmap',
    content: docContent('Cross Related Roadmap', '# Cross Related Roadmap\n\n## Milestones\nQ1: Foundation\nQ2: Growth\nQ3: Scale'),
    projectId: pid,
    folderId,
  }, { 'X-Eidolon-Agent-Id': agentId });
  console.log(`cross_related=${relatedId} (v1)`);

  await patchId(`/api/companies/${cid}/artifacts/${relatedId}`, {
    version: 1,
    title: 'Cross Related Roadmap',
    content: docContent('Cross Related Roadmap', '# Cross Related Roadmap\n\n## Milestones\nQ1: Foundation\nQ2: Growth\nQ3: Scale\nQ4: Expansion'),
  }, { 'X-Eidolon-Agent-Id': agentId });
  console.log(`cross_related v2 created`);

  // ── Third artifact: same project, no folder, no agent → score 3, for links panel ──
  console.log('=== Creating third artifact (cross_peer) ===');
  const peerId = await postId(`/api/companies/${cid}/artifacts`, {
    type: 'document',
    title: 'Cross Peer Strategy',
    content: docContent('Cross Peer Strategy', '# Cross Peer Strategy\n\nStrategic initiatives for the year.'),
    projectId: pid,
  });
  console.log(`cross_peer=${peerId}`);

  // ── Threads with @-mentions of cross_main ──
  console.log('=== Creating threads with @-mentions ===');
  const thread1 = await postId(`/api/companies/${cid}/projects/${pid}/threads`, {
    title: 'Budget Discussion Thread',
    type: 'conversation',
  });
  console.log(`thread1=${thread1}`);

  const thread2 = await postId(`/api/companies/${cid}/projects/${pid}/threads`, {
    title: 'Roadmap Planning Thread',
    type: 'conversation',
  });
  console.log(`thread2=${thread2}`);

  // Thread1 items: mention cross_main (linkedFrom) + cross_related (co-mention)
  console.log('=== Creating thread items ===');
  const item1 = await postId(`/api/companies/${cid}/projects/${pid}/threads/${thread1}/items`, {
    kind: 'comment',
    content: 'Reviewing the Cross Main Budget Plan for Q3. The forecast looks solid. @Cross Main Budget Plan needs approval before Friday.',
    mentions: [artMention(mainId)],
  });
  console.log(`item1=${item1}`);

  const item2 = await postId(`/api/companies/${cid}/projects/${pid}/threads/${thread1}/items`, {
    kind: 'comment',
    content: 'The Cross Related Roadmap aligns with the budget. @Cross Related Roadmap should be reviewed alongside @Cross Main Budget Plan.',
    mentions: [artMention(relatedId), artMention(mainId)],
  }, { 'X-Eidolon-Agent-Id': agentId });
  console.log(`item2=${item2}`);

  // Thread2 item: mentions cross_main only
  const item3 = await postId(`/api/companies/${cid}/projects/${pid}/threads/${thread2}/items`, {
    kind: 'comment',
    content: 'Planning session for the budget. @Cross Main Budget Plan is the key document.',
    mentions: [artMention(mainId)],
  });
  console.log(`item3=${item3}`);

  // ── A task with searchable content ──
  console.log('=== Creating a task ===');
  const taskRes = await api('POST', `/api/companies/${cid}/tasks`, {
    projectId: pid,
    title: 'Budget Review Task',
    description: 'Review the Cross Main Budget Plan and approve Q3 forecast numbers.',
    type: 'feature',
    status: 'todo',
    priority: 'high',
  });
  const taskId = taskRes.data?.id || taskRes.id;
  console.log(`task=${taskId}`);

  // Write fixture-ids.json
  const fixture = {
    company: { id: cid, name: '__mtest__ Cross Integration' },
    project: { id: pid },
    folder: { id: folderId },
    agentId,
    artifacts: {
      cross_main: mainId,
      cross_related: relatedId,
      cross_peer: peerId,
    },
    threads: {
      thread1: { id: thread1, title: 'Budget Discussion Thread', itemCount: 2 },
      thread2: { id: thread2, title: 'Roadmap Planning Thread', itemCount: 1 },
    },
    threadItems: {
      item1: { id: item1, threadId: thread1, mentions: [mainId] },
      item2: { id: item2, threadId: thread1, mentions: [relatedId, mainId] },
      item3: { id: item3, threadId: thread2, mentions: [mainId] },
    },
    task: { id: taskId },
    searchTerms: {
      budget: 'matches cross_main (title + content) + task (title + description)',
      roadmap: 'matches cross_related (title + content)',
      forecast: 'matches cross_main content (Q3/Q4 Forecast lines)',
    },
    revisionPairs: {
      cross_main: { v1: 1, v2: 2, v3: 3 },
      cross_related: { v1: 1, v2: 2 },
    },
  };

  const outDir = `${MISSION_DIR}/validation/cross-integration/user-testing`;
  mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/fixture-ids.json`;
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`\n=== Fixture IDs written to ${outPath} ===`);
  console.log(`Company: ${cid}`);
  console.log(`cross_main: ${mainId} (3 revisions, mentioned in 3 thread items)`);
  console.log(`cross_related: ${relatedId} (2 revisions, co-mentioned)`);
}

main().catch((e) => {
  console.error('SEED FAILED:', e.message);
  process.exit(1);
});
