import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { localDatabaseUrl, probeDatabase, waitForDatabase } from './local-server.mjs';

const url = 'postgres://operator:secret@127.0.0.1:55322/postgres';

test('requires local configuration and follows bootstrap URL precedence', () => {
  assert.equal(localDatabaseUrl({ DATABASE_URL: url, POSTGRES_URL: 'invalid' }), url);
  assert.equal(localDatabaseUrl({ POSTGRES_URL: url }), url);
  assert.equal(localDatabaseUrl({ POSTGRES_URL_NON_POOLING: url }), url);
  for (const value of [undefined, 'secret', 'https://localhost/db', 'postgres://hosted/db']) {
    assert.throws(() => localDatabaseUrl({ DATABASE_URL: value }));
  }
});

test('waits, caps backoff, redacts errors, and recovers exactly once', async () => {
  const delays = [];
  const logs = [];
  let attempts = 0;
  await waitForDatabase(url, {
    probe: async () => {
      if (++attempts <= 6) {
        throw new Error(url);
      }
    },
    delay: async (ms) => delays.push(ms),
    log: (message) => logs.push(message),
  });
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(attempts, 7);
  assert.match(logs.at(-1), /SQL ready/);
  assert.ok(logs.every((message) => !message.includes('secret')));
});

test('a closed port does not pass readiness', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(probeDatabase(`postgres://operator:secret@127.0.0.1:${port}/postgres`));
});

test('a silent TCP peer is not Postgres readiness and times out', { timeout: 10000 }, async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      probeDatabase(`postgres://operator:secret@127.0.0.1:${server.address().port}/postgres`),
    );
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
