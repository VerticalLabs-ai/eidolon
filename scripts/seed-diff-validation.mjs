#!/usr/bin/env node
// Seed diff validation fixture for M2 user-testing.
// Creates a __mtest__ company with artifacts of all 9 types, each with 3
// revisions (v1 → v2 → v3) containing known changes for diff verification.
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

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

async function patchId(path, body) {
  const r = await api('PATCH', path, body);
  return r.data;
}

// Content builders for each type — v1, v2, v3 with known changes

// Document: line-level changes
const docV1 = { format: 'markdown', body: 'Introduction\nOverview\nConclusion' };
const docV2 = { format: 'markdown', body: 'Introduction\nOverview\nDetails\nConclusion' }; // added "Details"
const docV3 = { format: 'markdown', body: 'Introduction\nOverview\nDetails\nSummary\nFinal Conclusion' }; // added "Summary", modified "Conclusion" → "Final Conclusion"

// Sheet: column + row + cell changes
const sheetV1 = {
  columns: [{ id: 'col1', key: 'name' }],
  rows: [{ id: 'row1', cells: { name: { value: 'Alice' } } }],
};
const sheetV2 = {
  columns: [{ id: 'col1', key: 'name' }, { id: 'col2', key: 'age' }], // added col2
  rows: [
    { id: 'row1', cells: { name: { value: 'Alice' }, age: { value: 30 } } }, // modified row1 (added age cell)
    { id: 'row2', cells: { name: { value: 'Bob' }, age: { value: 25 } } }, // added row2
  ],
};
const sheetV3 = {
  columns: [{ id: 'col1', key: 'name' }, { id: 'col2', key: 'age' }],
  rows: [{ id: 'row1', cells: { name: { value: 'Alice' }, age: { value: 31 } } }], // removed row2, modified row1 age 30→31
};

// Board: card added/removed/moved/modified
const boardV1 = {
  columns: [{ id: 'todo', title: 'Todo' }, { id: 'done', title: 'Done' }],
  cards: [{ id: 'c1', columnId: 'todo', title: 'Task A', order: 0 }],
};
const boardV2 = {
  columns: [{ id: 'todo', title: 'Todo' }, { id: 'done', title: 'Done' }],
  cards: [
    { id: 'c1', columnId: 'done', title: 'Task A', order: 0 }, // moved c1 todo→done
    { id: 'c2', columnId: 'todo', title: 'Task B', order: 1 }, // added c2
  ],
};
const boardV3 = {
  columns: [{ id: 'todo', title: 'Todo' }, { id: 'done', title: 'Done' }],
  cards: [
    { id: 'c1', columnId: 'done', title: 'Task A Updated', order: 0 }, // modified c1 title
    { id: 'c2', columnId: 'todo', title: 'Task B', order: 1 },
  ],
};

// Slides: slide add/remove/reorder + block-level deltas
const slidesV1 = {
  slides: [{ id: 's1', layout: 'title', blocks: [{ type: 'text', content: { text: 'Intro' } }] }],
};
const slidesV2 = {
  slides: [
    { id: 's1', layout: 'title', blocks: [{ type: 'text', content: { text: 'Intro' } }] },
    { id: 's2', layout: 'content', blocks: [{ type: 'text', content: { text: 'Details' } }] }, // added s2
  ],
};
const slidesV3 = {
  slides: [
    { id: 's2', layout: 'content', blocks: [{ type: 'text', content: { text: 'Details Updated' } }] }, // reordered s2 first, modified block
    { id: 's1', layout: 'title', blocks: [{ type: 'text', content: { text: 'Intro' } }] },
  ],
};

// Timeline: task add/remove/modify with field-level deltas
const timelineV1 = {
  tasks: [{ id: 't1', title: 'Setup', start: '2025-01-01', end: '2025-01-15', progress: 0 }],
};
const timelineV2 = {
  tasks: [
    { id: 't1', title: 'Setup', start: '2025-01-01', end: '2025-01-20', progress: 50 }, // modified end + progress
    { id: 't2', title: 'Deploy', start: '2025-02-01', end: '2025-02-15', progress: 0 }, // added t2
  ],
};
const timelineV3 = {
  tasks: [{ id: 't1', title: 'Setup', start: '2025-01-01', end: '2025-01-20', progress: 100 }], // removed t2, modified progress
};

// Gallery: item add/remove/modify with url/caption deltas
const galleryV1 = {
  items: [{ id: 'i1', type: 'image', url: 'https://example.com/1.png', caption: 'First' }],
};
const galleryV2 = {
  items: [
    { id: 'i1', type: 'image', url: 'https://example.com/1.png', caption: 'First Updated' }, // modified caption
    { id: 'i2', type: 'image', url: 'https://example.com/2.png', caption: 'Second' }, // added i2
  ],
};
const galleryV3 = {
  items: [{ id: 'i1', type: 'image', url: 'https://example.com/1b.png', caption: 'First Updated' }], // modified url, removed i2
};

// Dashboard: data source + widget changes
const dashboardV1 = {
  dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: {} } }],
  widgets: [{ id: 'w1', type: 'metric', dataSourceId: 'ds1', config: { title: 'Sales' } }],
};
const dashboardV2 = {
  dataSources: [
    { id: 'ds1', type: 'manual_json', config: { data: {} } },
    { id: 'ds2', type: 'analytics_endpoint', config: { endpoint: 'https://api.example.com' } }, // added ds2
  ],
  widgets: [
    { id: 'w1', type: 'metric', dataSourceId: 'ds1', config: { title: 'Revenue' } }, // modified w1 title
    { id: 'w2', type: 'chart', dataSourceId: 'ds2', config: { type: 'bar' } }, // added w2
  ],
};
const dashboardV3 = {
  dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: {} } }], // removed ds2
  widgets: [{ id: 'w1', type: 'metric', dataSourceId: 'ds1', config: { title: 'Revenue' } }], // removed w2
};

// App: file-level + line diff
const appV1 = {
  definition: { name: 'Demo App' },
  files: [{ path: 'index.html', content: '<html>\n<head>\n</head>\n<body>\n<h1>Hello</h1>\n</body>\n</html>' }],
};
const appV2 = {
  definition: { name: 'Demo App' },
  files: [
    { path: 'index.html', content: '<html>\n<head>\n</head>\n<body>\n<h1>Hello World</h1>\n</body>\n</html>' }, // modified
    { path: 'style.css', content: 'body { margin: 0; }' }, // added
  ],
};
const appV3 = {
  definition: { name: 'Demo App' },
  files: [{ path: 'index.html', content: '<html>\n<head>\n</head>\n<body>\n<h1>Hello World</h1>\n<p>Welcome</p>\n</body>\n</html>' }], // modified, removed style.css
};

// Code: file-level + line diff
const codeV1 = {
  language: 'javascript',
  files: [{ path: 'main.js', content: 'function main() {\n  return 1;\n}' }],
};
const codeV2 = {
  language: 'javascript',
  files: [
    { path: 'main.js', content: 'function main() {\n  return 2;\n}' }, // modified
    { path: 'utils.js', content: 'function helper() {\n  return true;\n}' }, // added
  ],
};
const codeV3 = {
  language: 'javascript',
  files: [{ path: 'main.js', content: 'function main() {\n  return 2;\n  // done\n}' }], // modified, removed utils.js
};

// Identical-content pair for "empty diff" tests (VAL-DIFF-016/020/024/028/032/036/040/044/048)
const docIdentical = { format: 'markdown', body: 'Same content\nNo changes here' };

async function main() {
  console.log('=== Creating diff validation company ===');
  const cid = await postId('/api/companies', { name: '__mtest__ Diff Validation', settings: { testFixture: true } });
  console.log(`CID=${cid}`);

  console.log('=== Creating project ===');
  const pid = await postId(`/api/companies/${cid}/projects`, { name: 'Diff Proj', status: 'active' });
  console.log(`PID=${pid}`);

  // Helper: create artifact (v1), update to v2, update to v3
  async function mkWithRevisions(type, title, v1Content, v2Content, v3Content) {
    const aid = await postId(`/api/companies/${cid}/artifacts`, { type, title, content: v1Content, projectId: pid });
    await patchId(`/api/companies/${cid}/artifacts/${aid}`, { content: v2Content, version: 1 });
    await patchId(`/api/companies/${cid}/artifacts/${aid}`, { content: v3Content, version: 2 });
    return aid;
  }

  // Helper: create artifact with identical revisions (for empty-diff tests)
  async function mkIdenticalRevisions(type, title, content) {
    const aid = await postId(`/api/companies/${cid}/artifacts`, { type, title, content, projectId: pid });
    await patchId(`/api/companies/${cid}/artifacts/${aid}`, { content, version: 1 });
    return aid;
  }

  const ids = {};

  console.log('=== Creating 9 typed artifacts with 3 revisions each ===');
  ids.document = await mkWithRevisions('document', 'Diff Document', docV1, docV2, docV3);
  ids.sheet = await mkWithRevisions('sheet', 'Diff Sheet', sheetV1, sheetV2, sheetV3);
  ids.board = await mkWithRevisions('board', 'Diff Board', boardV1, boardV2, boardV3);
  ids.slide_deck = await mkWithRevisions('slide_deck', 'Diff Slides', slidesV1, slidesV2, slidesV3);
  ids.timeline = await mkWithRevisions('timeline', 'Diff Timeline', timelineV1, timelineV2, timelineV3);
  ids.gallery = await mkWithRevisions('gallery', 'Diff Gallery', galleryV1, galleryV2, galleryV3);
  ids.dashboard = await mkWithRevisions('dashboard', 'Diff Dashboard', dashboardV1, dashboardV2, dashboardV3);
  ids.app = await mkWithRevisions('app', 'Diff App', appV1, appV2, appV3);
  ids.code = await mkWithRevisions('code', 'Diff Code', codeV1, codeV2, codeV3);
  console.log('9 typed artifacts with 3 revisions done');

  console.log('=== Creating identical-revision artifacts for empty-diff tests ===');
  ids.doc_identical = await mkIdenticalRevisions('document', 'Identical Doc', docIdentical);
  console.log('Identical doc done');

  console.log('=== Creating second company for scoping test ===');
  const cid2 = await postId('/api/companies', { name: '__mtest__ Diff Other Corp', settings: { testFixture: true } });
  const pid2 = await postId(`/api/companies/${cid2}/projects`, { name: 'Other Proj', status: 'active' });
  // Create an artifact in company 2 with the same title as the diff document
  ids.doc_other_company = await postId(`/api/companies/${cid2}/artifacts`, { type: 'document', title: 'Diff Document', content: docV1, projectId: pid2 });
  console.log(`CID2=${cid2} PID2=${pid2}`);

  // Write fixture-ids.json
  const fixture = {
    company: { id: cid, name: '__mtest__ Diff Validation' },
    company2: { id: cid2, name: '__mtest__ Diff Other Corp' },
    project: { id: pid },
    project2: { id: pid2 },
    artifacts: ids,
    revisionPairs: {
      // v1→v2, v1→v3, v2→v3 for each type
      document: { v1: 1, v2: 2, v3: 3 },
      sheet: { v1: 1, v2: 2, v3: 3 },
      board: { v1: 1, v2: 2, v3: 3 },
      slide_deck: { v1: 1, v2: 2, v3: 3 },
      timeline: { v1: 1, v2: 2, v3: 3 },
      gallery: { v1: 1, v2: 2, v3: 3 },
      dashboard: { v1: 1, v2: 2, v3: 3 },
      app: { v1: 1, v2: 2, v3: 3 },
      code: { v1: 1, v2: 2, v3: 3 },
    },
  };

  const outPath = `${MISSION_DIR}/validation/m2-diff/user-testing/fixture-ids.json`;
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`\n=== Fixture IDs written to ${outPath} ===`);
  console.log(JSON.stringify(fixture, null, 2));
}

main().catch((e) => {
  console.error('SEED FAILED:', e.message);
  process.exit(1);
});
