#!/usr/bin/env node
// Seed links validation fixture for M3 user-testing.
// Creates a __mtest__ company with artifacts, threads, and @-mentions
// for smart artifact linking verification (VAL-LINK-001..046).
import { readFileSync, writeFileSync } from 'node:fs';

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
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function postId(path, body, headers) {
  const r = await api('POST', path, body, headers);
  return r.data.id;
}

function docContent(title) {
  return { format: 'markdown', body: `# ${title}\n\nContent for ${title}.` };
}

async function main() {
  console.log('=== Creating links validation company ===');
  const cid = await postId('/api/companies', { name: '__mtest__ Links Validation', settings: { testFixture: true } });
  console.log(`CID=${cid}`);

  console.log('=== Creating project ===');
  const pid = await postId(`/api/companies/${cid}/projects`, { name: 'Links Proj', status: 'active' });
  console.log(`PID=${pid}`);

  console.log('=== Creating second project (for isolated artifact) ===');
  const pid2 = await postId(`/api/companies/${cid}/projects`, { name: 'Isolated Proj', status: 'active' });
  console.log(`PID2=${pid2}`);

  console.log('=== Creating folder ===');
  const folderA = await postId(`/api/companies/${cid}/folders`, { name: 'Links Folder A', projectId: pid });
  console.log(`FOLDER_A=${folderA}`);

  console.log('=== Creating agent ===');
  const agentId = await postId(`/api/companies/${cid}/agents`, { name: 'Links Agent', role: 'engineer', provider: 'anthropic' });
  console.log(`AGENT=${agentId}`);

  // Helper: create artifact (optionally agent-authored)
  async function mkArt(title, opts = {}) {
    const headers = opts.agentId ? { 'X-Eidolon-Agent-Id': opts.agentId } : {};
    const aid = await postId(`/api/companies/${cid}/artifacts`, {
      type: 'document',
      title,
      content: docContent(title),
      projectId: opts.projectId ?? pid,
      folderId: opts.folderId ?? null,
    }, headers);
    return aid;
  }

  const ids = {};

  console.log('=== Creating target artifact (agent-authored, in project + folder) ===');
  ids.target_main = await mkArt('Target Main Doc', { agentId, folderId: folderA });
  console.log(`target_main=${ids.target_main}`);

  console.log('=== Creating scoring test artifacts ===');
  // multi_signal: project + folder + agent + co-mention → score 8
  ids.multi_signal = await mkArt('Multi Signal Doc', { agentId, folderId: folderA });
  // agent_folder: project + folder + agent → score 7 (no co-mention)
  ids.agent_folder = await mkArt('Agent Folder Doc', { agentId, folderId: folderA });
  // same_folder: project + folder → score 5
  ids.same_folder = await mkArt('Same Folder Doc', { folderId: folderA });
  // agent_edited: project + agent → score 5
  ids.agent_edited = await mkArt('Agent Edited Doc', { agentId });
  // co_mentioned: project + co-mention → score 4
  ids.co_mentioned = await mkArt('Co Mentioned Doc');
  // same_project: project only → score 3
  ids.same_project = await mkArt('Same Project Doc');
  // no_mentions: project only, never mentioned → empty linkedFrom, score 3 related
  ids.no_mentions = await mkArt('No Mentions Doc');
  // isolated: different project, no folder, no agent, no mentions → empty related
  ids.isolated = await mkArt('Isolated Doc', { projectId: pid2 });

  console.log('=== Creating 12 extra artifacts in project for top-10 limit test ===');
  for (let i = 1; i <= 12; i++) {
    ids[`extra${i}`] = await mkArt(`Extra Doc ${i}`);
  }

  console.log('=== Creating archived artifact (should NOT appear in related) ===');
  ids.archived_art = await mkArt('Archived Doc');
  await api('POST', `/api/companies/${cid}/artifacts/${ids.archived_art}/archive`);

  console.log('=== Creating deleted artifact (should NOT appear in related) ===');
  ids.deleted_art = await mkArt('Deleted Doc');
  await api('DELETE', `/api/companies/${cid}/artifacts/${ids.deleted_art}`);

  console.log('=== Creating threads ===');
  // thread1: "Target Discussion" — 2 items mentioning target_main (VAL-LINK-022)
  const thread1 = await postId(`/api/companies/${cid}/projects/${pid}/threads`, { title: 'Target Discussion', type: 'conversation' });
  console.log(`thread1=${thread1}`);

  // thread2: "Co-mention Thread" — 1 item mentioning target_main + co_mentioned + multi_signal
  const thread2 = await postId(`/api/companies/${cid}/projects/${pid}/threads`, { title: 'Co-mention Thread', type: 'conversation' });
  console.log(`thread2=${thread2}`);

  // thread3: "Mixed Mentions" — 1 item with artifact + agent + user mentions (VAL-LINK-044)
  const thread3 = await postId(`/api/companies/${cid}/projects/${pid}/threads`, { title: 'Mixed Mentions Thread', type: 'conversation' });
  console.log(`thread3=${thread3}`);

  // thread4: "Many Mentions" — 25 items mentioning target_main (VAL-LINK-026)
  const thread4 = await postId(`/api/companies/${cid}/projects/${pid}/threads`, { title: 'Many Mentions Thread', type: 'conversation' });
  console.log(`thread4=${thread4}`);

  // Helper: create thread item with mentions
  async function mkItem(threadId, content, mentions, opts = {}) {
    const body = {
      kind: 'comment',
      content,
      mentions,
    };
    if (opts.authorAgentId) body.authorAgentId = opts.authorAgentId;
    const r = await api('POST', `/api/companies/${cid}/projects/${pid}/threads/${threadId}/items`, body);
    return r.data.id;
  }

  function artMention(aid, artifactType = 'document') {
    return { entityType: 'artifact', entityId: aid, label: 'artifact', artifactType };
  }

  function agentMention(aid) {
    return { entityType: 'agent', entityId: aid, label: 'agent' };
  }

  function userMention(uid) {
    return { entityType: 'user', entityId: uid, label: 'user' };
  }

  // IMPORTANT: Create thread4 (25 bulk items) FIRST so they are the OLDEST.
  // Then create thread1/2/3 items AFTER so they are the MOST RECENT and
  // appear in the top-20 linkedFrom (ordered by createdAt DESC). This ensures
  // the co-mention thread item (thread2) is in the top 20, populating linkedTo
  // and applying co-mention scores to related artifacts.
  console.log('=== Creating thread4 items (25 OLDEST items mentioning target_main) ===');
  for (let i = 0; i < 25; i++) {
    await mkItem(thread4, `Bulk mention item ${i} for the target artifact.`, [artMention(ids.target_main)]);
  }

  console.log('=== Creating thread1 items (2 recent items mentioning target_main) ===');
  await mkItem(thread1, 'First comment about the target artifact for discussion.', [artMention(ids.target_main)]);
  await mkItem(thread1, 'Second comment also referencing the target artifact.', [artMention(ids.target_main)], { authorAgentId: agentId });

  console.log('=== Creating thread2 item (co-mention: target_main + co_mentioned + multi_signal) ===');
  await mkItem(thread2, 'Discussing target alongside co-mentioned and multi-signal docs.', [
    artMention(ids.target_main),
    artMention(ids.co_mentioned),
    artMention(ids.multi_signal),
  ]);

  console.log('=== Creating thread3 item (mixed: artifact + agent + user mentions) ===');
  // Use a known dev user id for local_trusted. The dev user id is typically 'dev-user-000'
  // but the mention service must resolve it. Use the agentId for the agent mention.
  await mkItem(thread3, 'Mixed mention item referencing artifact, agent, and user.', [
    artMention(ids.target_main),
    agentMention(agentId),
    userMention('dev-user-000'),
  ]);

  console.log('=== Creating second company for scoping test ===');
  const cid2 = await postId('/api/companies', { name: '__mtest__ Links Other Corp', settings: { testFixture: true } });
  const pid2c2 = await postId(`/api/companies/${cid2}/projects`, { name: 'Other Proj', status: 'active' });
  const agentId2 = await postId(`/api/companies/${cid2}/agents`, { name: 'Other Agent', role: 'engineer', provider: 'anthropic' });
  // Artifact in company2 with same title as target_main
  ids.other_company_art = await postId(`/api/companies/${cid2}/artifacts`, {
    type: 'document', title: 'Target Main Doc', content: docContent('Target Main Doc'), projectId: pid2c2,
  });
  // Thread in company2 mentioning other_company_art (should NOT appear in company1's linkedFrom)
  const thread_c2 = await postId(`/api/companies/${cid2}/projects/${pid2c2}/threads`, { title: 'Other Corp Thread', type: 'conversation' });
  await api('POST', `/api/companies/${cid2}/projects/${pid2c2}/threads/${thread_c2}/items`, {
    kind: 'comment',
    content: 'Mentioning the other company artifact.',
    mentions: [artMention(ids.other_company_art)],
  });
  console.log(`CID2=${cid2} PID2C2=${pid2c2}`);

  // Write fixture-ids.json
  const fixture = {
    company: { id: cid, name: '__mtest__ Links Validation' },
    company2: { id: cid2, name: '__mtest__ Links Other Corp' },
    project: { id: pid },
    project2: { id: pid2 },
    project2c2: { id: pid2c2 },
    folderA,
    agentId,
    agentId2,
    artifacts: ids,
    threads: {
      thread1: { id: thread1, title: 'Target Discussion', itemCount: 2 },
      thread2: { id: thread2, title: 'Co-mention Thread', itemCount: 1 },
      thread3: { id: thread3, title: 'Mixed Mentions Thread', itemCount: 1 },
      thread4: { id: thread4, title: 'Many Mentions Thread', itemCount: 25 },
    },
    thread_c2: { id: thread_c2, companyId: cid2 },
    dbUrl: DB_URL,
    // Expected related scores for target_main:
    // multi_signal: 8 (project+folder+agent+co-mention)
    // agent_folder: 7 (project+folder+agent)
    // same_folder: 5 (project+folder)
    // agent_edited: 5 (project+agent)
    // co_mentioned: 4 (project+co-mention)
    // same_project: 3, no_mentions: 3, extra1..extra12: 3 each
    // Total related candidates: 17 (5 named + 12 extras), top 10 returned
    expectedScores: {
      multi_signal: 8,
      agent_folder: 7,
      same_folder: 5,
      agent_edited: 5,
      co_mentioned: 4,
      same_project: 3,
      no_mentions: 3,
    },
  };

  const outDir = `${MISSION_DIR}/validation/m3-links/user-testing`;
  const outPath = `${outDir}/fixture-ids.json`;
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`\n=== Fixture IDs written to ${outPath} ===`);
  console.log(`Company: ${cid}`);
  console.log(`Target artifact: ${ids.target_main}`);
  console.log(`Total artifacts in company: ${Object.keys(ids).length + 1}`); // +1 for target_main
}

main().catch((e) => {
  console.error('SEED FAILED:', e.message);
  process.exit(1);
});
