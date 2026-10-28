const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const session = require('express-session');
const { createApp } = require('../server');

// Real HTTP/session/CSRF routes with an in-memory allowlist. The fake transaction
// mutex models the row locks so concurrent removals exercise the caller recheck.
async function setup(t, options = {}) {
  const users = [
    { AccountID: 1, Email: 'faculty@example.edu' },
    { AccountID: 2, Email: 'other@example.edu' }
  ];
  const calls = { queries: [], transactions: [] };
  let nextId = 3;
  let queue = Promise.resolve();
  const control = { beforeWrite: null };
  async function execute(sql, values = []) {
    calls.queries.push({ sql, values });
    if (sql.startsWith('SELECT AccountID, Email FROM FacultyAccount')) {
      const rows = sql.includes('LOWER(TRIM(Email))')
        ? users.filter(user => user.Email.trim().toLowerCase() === values[0]) : users;
      return [rows.map(user => ({ ...user }))];
    }
    if (sql.startsWith('INSERT INTO FacultyAccount')) {
      if (options.failInsert) throw Object.assign(new Error('Private SQL details'), { code: options.failInsert });
      const user = { AccountID: nextId++, Email: values[0] };
      users.push(user);
      return [{ insertId: user.AccountID }];
    }
    if (sql.startsWith('DELETE FROM FacultyAccount')) {
      if (options.failDelete) throw new Error('Private SQL details');
      const index = users.findIndex(user => user.AccountID === values[0]);
      if (index >= 0) users.splice(index, 1);
      return [{ affectedRows: index >= 0 ? 1 : 0 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  const db = {
    execute,
    async getConnection() {
      if (control.beforeWrite) { control.beforeWrite(); control.beforeWrite = null; }
      let unlock;
      let snapshot;
      return {
        async beginTransaction() {
          const previous = queue;
          queue = new Promise(resolve => { unlock = resolve; });
          await previous;
          snapshot = users.map(user => ({ ...user }));
          calls.transactions.push('begin');
        },
        execute,
        async commit() { calls.transactions.push('commit'); },
        async rollback() {
          users.splice(0, users.length, ...snapshot);
          calls.transactions.push('rollback');
        },
        release() { calls.transactions.push('release'); unlock(); }
      };
    }
  };
  let identity;
  let nonce;
  const app = createApp({ db, storage: {}, auth: {
    clientId: 'test-client', clientSecret: 'test-secret', publicOrigin: 'http://localhost',
    sessionSecret: 'test-only-session-secret-with-more-than-32-bytes', store: new session.MemoryStore(),
    googleClient: {
      generateAuthUrl(params) { nonce = params.nonce; return `https://accounts.google.com/?state=${params.state}`; },
      async getToken() { return { tokens: { id_token: 'test-token' } }; },
      async verifyIdToken() { return { getPayload: () => ({
        sub: 'test-subject', email: identity, email_verified: true, hd: 'example.edu', nonce
      }) }; }
    }
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, settings = {}) => fetch(base + url, { ...settings, redirect: 'manual' });
  async function signIn(email = 'faculty@example.edu') {
    identity = email;
    const begin = await request('/auth/google');
    const state = new URL(begin.headers.get('location')).searchParams.get('state');
    const response = await request(`/auth/google/callback?code=test-code&state=${state}`, {
      headers: { Cookie: begin.headers.getSetCookie()[0].split(';')[0] }
    });
    const Cookie = response.headers.getSetCookie()[0].split(';')[0];
    const result = await (await request('/api/auth/session', { headers: { Cookie } })).json();
    return { Cookie, Origin: 'http://localhost', 'X-CSRF-Token': result.csrfToken };
  }
  const json = (method, headers, body) => ({
    method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { users, calls, control, request, signIn, json };
}

test('faculty can view the allowlist and identify their own account', async t => {
  const { request, signIn } = await setup(t);
  const response = await request('/api/admin/users', { headers: await signIn() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), [
    { AccountID: 1, Email: 'faculty@example.edu', isCurrentUser: true },
    { AccountID: 2, Email: 'other@example.edu', isCurrentUser: false }
  ]);
});

test('adding a normalized faculty email allows that Google identity to sign in', async t => {
  const { request, signIn, json, users, calls } = await setup(t);
  const response = await request('/api/admin/users', json('POST', await signIn(), { email: '  NEW@Example.edu  ' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { AccountID: 3, Email: 'new@example.edu' });
  assert.equal(users.at(-1).Email, 'new@example.edu');
  assert.deepEqual(calls.transactions, ['begin', 'commit', 'release']);
  assert.equal((await request('/api/admin/users', { headers: await signIn('new@example.edu') })).status, 200);
});

test('removing a user revokes their already active session and future sign-ins', async t => {
  const { request, signIn, users } = await setup(t);
  const other = await signIn('other@example.edu');
  const response = await request('/api/admin/users/2', { method: 'DELETE', headers: await signIn() });
  assert.equal(response.status, 200);
  assert.deepEqual(users, [{ AccountID: 1, Email: 'faculty@example.edu' }]);
  assert.equal((await request('/api/admin/users', { headers: other })).status, 401);
  assert.equal((await request('/api/admin/users', { headers: await signIn('other@example.edu') })).status, 401);
});

test('anonymous callers cannot read or modify the user list', async t => {
  const { request, json, calls } = await setup(t);
  for (const [url, options] of [
    ['/api/admin/users', {}],
    ['/api/admin/users', json('POST', {}, { email: 'new@example.edu' })],
    ['/api/admin/users/2', { method: 'DELETE' }]
  ]) assert.equal((await request(url, options)).status, 401);
  assert.equal(calls.queries.length, 0);
});

test('adding and removing users require the correct CSRF token and origin', async t => {
  const { request, signIn, json, calls } = await setup(t);
  const valid = await signIn();
  for (const headers of [
    { Cookie: valid.Cookie },
    { ...valid, 'X-CSRF-Token': 'wrong' },
    { ...valid, Origin: 'https://other.example' }
  ]) {
    assert.equal((await request('/api/admin/users', json('POST', headers, { email: 'new@example.edu' }))).status, 403);
    assert.equal((await request('/api/admin/users/2', { method: 'DELETE', headers })).status, 403);
  }
  assert.deepEqual(calls.transactions, []);
});

test('invalid user creation payloads fail before starting a transaction', async t => {
  const { request, signIn, json, calls } = await setup(t);
  const headers = await signIn();
  for (const body of [
    {}, [], null, { email: false }, { email: '' }, { email: 'not-an-email' },
    { email: 'bad @example.edu' }, { email: 'a'.repeat(100) + '@example.edu' },
    { email: 'new@example.edu', role: 'admin' }
  ]) {
    const response = await request('/api/admin/users', json('POST', headers, body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls.transactions, []);
});

test('duplicate emails are rejected without inserting a second account', async t => {
  const { request, signIn, json, users, calls } = await setup(t);
  const response = await request('/api/admin/users', json('POST', await signIn(), { email: ' FACULTY@EXAMPLE.EDU ' }));
  assert.equal(response.status, 409);
  assert.equal(users.length, 2);
  assert.deepEqual(calls.transactions, ['begin', 'rollback', 'release']);
  assert.equal(calls.queries.some(query => query.sql.startsWith('INSERT')), false);
});

test('database unique violations become a conflict without disclosing SQL details', async t => {
  const { request, signIn, json, users } = await setup(t, { failInsert: 'ER_DUP_ENTRY' });
  const response = await request('/api/admin/users', json('POST', await signIn(), { email: 'new@example.edu' }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'That email is already in the user list.' });
  assert.equal(users.length, 2);
});

test('invalid, missing, and self user removals leave the allowlist intact', async t => {
  const { request, signIn, users } = await setup(t);
  const headers = await signIn();
  for (const id of ['0', '-1', '1.5', '2x', '9007199254740992']) {
    assert.equal((await request(`/api/admin/users/${id}`, { method: 'DELETE', headers })).status, 400);
  }
  assert.equal((await request('/api/admin/users/999', { method: 'DELETE', headers })).status, 404);
  assert.equal((await request('/api/admin/users/1', { method: 'DELETE', headers })).status, 409);
  assert.equal(users.length, 2);
});

test('SQL failures roll back changes and release the connection', async t => {
  const { request, signIn, users, calls } = await setup(t, { failDelete: true });
  const response = await request('/api/admin/users/2', { method: 'DELETE', headers: await signIn() });
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /Private SQL details/);
  assert.equal(users.length, 2);
  assert.deepEqual(calls.transactions, ['begin', 'rollback', 'release']);
});

test('an administrator removed between authentication and mutation cannot change the allowlist', async t => {
  for (const method of ['POST', 'DELETE']) {
    await t.test(method, async t => {
      const { request, signIn, json, users, control } = await setup(t);
      const headers = await signIn();
      control.beforeWrite = () => users.splice(0, 1);
      const response = method === 'POST'
        ? await request('/api/admin/users', json('POST', headers, { email: 'new@example.edu' }))
        : await request('/api/admin/users/2', { method: 'DELETE', headers });
      assert.equal(response.status, 401);
      assert.deepEqual(users, [{ AccountID: 2, Email: 'other@example.edu' }]);
    });
  }
});

test('concurrent administrators cannot remove each other and leave the allowlist empty', async t => {
  const { request, signIn, users } = await setup(t);
  const first = await signIn();
  const second = await signIn('other@example.edu');
  const responses = await Promise.all([
    request('/api/admin/users/2', { method: 'DELETE', headers: first }),
    request('/api/admin/users/1', { method: 'DELETE', headers: second })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
  assert.equal(users.length, 1);
});
