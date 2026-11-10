import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { createTestServer, createTestDb } from '../test-utils.js';
import {
  __resetCoEditSessions,
  applyOperation,
  flushSessionSerialized,
  hasSession,
  initCoEditManager,
  joinSession,
  leaveSession,
} from '../realtime/coedit-session.js';
import type { DbInstance } from '../types.js';

/**
 * Session teardown and persistence ordering [EID-171].
 *
 * These tests drive the session module directly with in-memory sockets, so
 * every interleaving is set up by the test itself: a write is held open at
 * the start of its transaction, the racing calls are made while it is held,
 * and only then is it released. No timers or network ordering are involved.
 */
describe('Co-edit session lifecycle — leaving while a write is in flight', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let artifactId: string;

  const artifactUrl = () => `/api/companies/${companyId}/artifacts/${artifactId}`;
  const alice = { userId: 'user-a', editSource: 'user' as const };

  beforeEach(async () => {
    __resetCoEditSessions();
    db = await createTestDb();
    app = await createTestServer(db);
    initCoEditManager(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ CoEdit Lifecycle', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const doc = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'document',
        title: '__mtest__ Lifecycle Doc',
        content: { format: 'markdown', body: '# Hello' },
      })
      .expect(201);
    artifactId = doc.body.data.id;
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  /** A participant connection that records what the server sends it. */
  async function join(userId: string, name: string) {
    const received: Record<string, unknown>[] = [];
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: (raw: string) => {
        received.push(JSON.parse(raw) as Record<string, unknown>);
      },
    } as unknown as WebSocket;
    await joinSession(artifactId, companyId, userId, name, ws);
    const joined = received.find((message) => message.type === 'coedit.joined') as
      { content: { body: string }; version: number } | undefined;
    return { received, joined };
  }

  /** Append text as `userId` and assert the server acknowledged the edit. */
  function appendAcknowledged(
    client: { received: Record<string, unknown>[] },
    userId: string,
    text: string,
  ): void {
    const opId = `op_${userId}_${text.trim()}`;
    applyOperation(
      artifactId,
      { kind: 'doc.insert', position: Number.MAX_SAFE_INTEGER, text, opId },
      userId,
    );
    expect(client.received).toContainEqual(
      expect.objectContaining({ type: 'coedit.op.ack', opId }),
    );
  }

  /**
   * Hold the next artifact write at the start of its transaction. `started`
   * resolves once the write is waiting; `release` lets it commit and `fail`
   * makes it reject as a lost database connection would.
   */
  function holdNextWrite() {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let shouldFail = false;
    const original = db.drizzle.transaction.bind(db.drizzle);
    vi.spyOn(db.drizzle, 'transaction').mockImplementationOnce(async (...args) => {
      markStarted();
      await gate;
      if (shouldFail) {
        throw new Error('connection lost');
      }
      return original(...args);
    });
    return {
      started,
      release: open,
      fail: () => {
        shouldFail = true;
        open();
      },
    };
  }

  function failNextWrite(): void {
    holdNextWrite().fail();
  }

  async function stored(): Promise<{ body: string; version: number }> {
    const res = await request(app).get(artifactUrl()).expect(200);
    return { body: res.body.data.content.body, version: res.body.data.version };
  }

  async function revisionCount(): Promise<number> {
    const res = await request(app).get(`${artifactUrl()}/revisions`).expect(200);
    return res.body.data.length;
  }

  /** A rejoin loads from the database only when the old session is gone. */
  async function expectSessionDisposed(): Promise<void> {
    expect(hasSession(artifactId)).toBe(false);
    const current = await stored();
    await request(app)
      .patch(artifactUrl())
      .send({ content: { format: 'markdown', body: '# Replaced' }, version: current.version })
      .expect(200);
    const fresh = await join('user-fresh', 'Fresh');
    expect(fresh.joined?.content.body).toBe('# Replaced');
    expect(fresh.joined?.version).toBe(current.version + 1);
  }

  // ── Leave during an awaited write ────────────────────────────────────

  it('persists an edit acknowledged after a save began when the editor then leaves', async () => {
    const a = await join('user-a', 'Alice');
    appendAcknowledged(a, 'user-a', ' A');

    const write = holdNextWrite();
    const save = flushSessionSerialized(artifactId, alice);
    await write.started;

    appendAcknowledged(a, 'user-a', ' B');
    const left = leaveSession(artifactId, 'user-a');

    write.release();
    await expect(save).resolves.toMatchObject({ version: 2 });
    await left;

    expect(await stored()).toEqual({ body: '# Hello A B', version: 3 });
    // One revision for the save, one for the final flush, and no duplicates.
    expect(await revisionCount()).toBe(3);
    await expectSessionDisposed();
  });

  it('writes nothing more when the save in flight already holds every edit', async () => {
    const a = await join('user-a', 'Alice');
    appendAcknowledged(a, 'user-a', ' A');

    const write = holdNextWrite();
    const save = flushSessionSerialized(artifactId, alice);
    await write.started;
    const left = leaveSession(artifactId, 'user-a');

    write.release();
    await save;
    await left;

    expect(await stored()).toEqual({ body: '# Hello A', version: 2 });
    expect(await revisionCount()).toBe(2);
    await expectSessionDisposed();
  });

  it('writes nothing when the last participant leaves a clean session', async () => {
    await join('user-a', 'Alice');
    await leaveSession(artifactId, 'user-a');

    expect(await stored()).toEqual({ body: '# Hello', version: 1 });
    expect(await revisionCount()).toBe(1);
    await expectSessionDisposed();
  });

  // ── Concurrent final edits ───────────────────────────────────────────

  it('persists the final edits of two editors who both leave during a write', async () => {
    const a = await join('user-a', 'Alice');
    const b = await join('user-b', 'Bao');
    appendAcknowledged(a, 'user-a', ' A');

    const write = holdNextWrite();
    const save = flushSessionSerialized(artifactId, alice);
    await write.started;

    appendAcknowledged(b, 'user-b', ' B');
    appendAcknowledged(a, 'user-a', ' C');
    const aliceLeft = leaveSession(artifactId, 'user-a');
    const baoLeft = leaveSession(artifactId, 'user-b');

    write.release();
    await save;
    await Promise.all([aliceLeft, baoLeft]);

    expect(b.received).toContainEqual(
      expect.objectContaining({ type: 'coedit.user.left', userId: 'user-a' }),
    );
    expect(await stored()).toEqual({ body: '# Hello A B C', version: 3 });
    expect(await revisionCount()).toBe(3);
    await expectSessionDisposed();
  });

  // ── Write failure ────────────────────────────────────────────────────

  it('keeps unsaved edits recoverable when the final flush fails', async () => {
    const a = await join('user-a', 'Alice');
    appendAcknowledged(a, 'user-a', ' A');

    failNextWrite();
    await expect(leaveSession(artifactId, 'user-a')).resolves.toBeUndefined();

    // Nothing reached the database, and the edit is still held for a rejoin.
    expect(await stored()).toEqual({ body: '# Hello', version: 1 });
    const back = await join('user-a', 'Alice');
    expect(back.joined).toMatchObject({ content: { body: '# Hello A' }, version: 1 });

    await leaveSession(artifactId, 'user-a');
    expect(await stored()).toEqual({ body: '# Hello A', version: 2 });
    await expectSessionDisposed();
  });

  it('retries in the final flush when the save it waited for fails', async () => {
    const a = await join('user-a', 'Alice');
    appendAcknowledged(a, 'user-a', ' A');

    const write = holdNextWrite();
    const save = flushSessionSerialized(artifactId, alice);
    await write.started;
    const left = leaveSession(artifactId, 'user-a');

    write.fail();
    await expect(save).rejects.toThrow('connection lost');
    await left;

    expect(await stored()).toEqual({ body: '# Hello A', version: 2 });
    expect(await revisionCount()).toBe(2);
    await expectSessionDisposed();
  });

  it('merges an agent update into unsaved edits held after a failed final flush', async () => {
    const a = await join('user-a', 'Alice');
    appendAcknowledged(a, 'user-a', ' A');
    failNextWrite();
    await leaveSession(artifactId, 'user-a');

    const patch = await request(app)
      .patch(artifactUrl())
      .send({ content: { format: 'markdown', body: 'Agent: # Hello' }, version: 1 })
      .expect(200);

    expect(patch.body.data.content.body).toBe('Agent: # Hello A');
    expect(await stored()).toEqual({ body: 'Agent: # Hello A', version: 2 });
    await expectSessionDisposed();
  });

  it('lets go of unsaved edits when the artifact was permanently deleted', async () => {
    const a = await join('user-a', 'Alice');
    appendAcknowledged(a, 'user-a', ' A');
    await db.drizzle.delete(db.schema.artifacts).where(eq(db.schema.artifacts.id, artifactId));

    await leaveSession(artifactId, 'user-a');

    expect(hasSession(artifactId)).toBe(false);
  });

  // ── Session disposal ─────────────────────────────────────────────────

  it('keeps the session for an editor who joins while the final flush is in flight', async () => {
    const a = await join('user-a', 'Alice');
    appendAcknowledged(a, 'user-a', ' A');

    const write = holdNextWrite();
    const left = leaveSession(artifactId, 'user-a');
    await write.started;

    const b = await join('user-b', 'Bao');
    expect(b.joined?.content.body).toBe('# Hello A');

    write.release();
    await left;

    // Bao's session is the one Alice left: it must still accept and save edits.
    appendAcknowledged(b, 'user-b', ' B');
    await expect(
      flushSessionSerialized(artifactId, { userId: 'user-b', editSource: 'user' }),
    ).resolves.toMatchObject({ version: 3 });
    expect(b.received).toContainEqual(
      expect.objectContaining({ type: 'coedit.saved', version: 2 }),
    );
    expect(await stored()).toEqual({ body: '# Hello A B', version: 3 });
  });

  // ── Agent updates share the same queue ───────────────────────────────

  it('persists an edit acknowledged while an agent update is being written', async () => {
    const a = await join('user-a', 'Alice');

    const write = holdNextWrite();
    const patch = request(app)
      .patch(artifactUrl())
      .send({ content: { format: 'markdown', body: 'Agent: # Hello' }, version: 1 })
      .then((res) => res);
    await write.started;

    appendAcknowledged(a, 'user-a', ' A');
    write.release();
    expect((await patch).status).toBe(200);

    await leaveSession(artifactId, 'user-a');
    expect(await stored()).toEqual({ body: 'Agent: # Hello A', version: 3 });
    await expectSessionDisposed();
  });

  it('queues a save behind an agent update instead of conflicting with it', async () => {
    const a = await join('user-a', 'Alice');

    const write = holdNextWrite();
    const patch = request(app)
      .patch(artifactUrl())
      .send({ content: { format: 'markdown', body: 'Agent: # Hello' }, version: 1 })
      .then((res) => res);
    await write.started;

    appendAcknowledged(a, 'user-a', ' A');
    const save = flushSessionSerialized(artifactId, alice);
    write.release();

    expect((await patch).status).toBe(200);
    await expect(save).resolves.toMatchObject({ version: 3 });
    expect(await stored()).toEqual({ body: 'Agent: # Hello A', version: 3 });
    expect(a.received.some((message) => message.type === 'coedit.error')).toBe(false);
  });
});
