const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const session = require('express-session');
const { createApp } = require('../server');
const { authConfigFromEnv, createSessionStore } = require('../auth');

// These tests exercise the HTTP boundary. Google and MySQL are replaced so no
// credentials, internet connection, or real faculty accounts are needed.
async function setup(t, options = {}) {
  const calls = { authorization: [], exchange: [], verification: [], queries: [] };
  const faculty = options.faculty ?? [{ AccountID: 7, Email: 'faculty@example.edu' }];
  const googleClient = {
    async generateCodeVerifierAsync() {
      const codeVerifier = 'test-code-verifier-that-is-long-enough-for-the-pkce-standard';
      return { codeVerifier, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url') };
    },
    generateAuthUrl(params) {
      calls.authorization.push(params);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [name, value] of Object.entries(params)) {
        url.searchParams.set(name, Array.isArray(value) ? value.join(' ') : value);
      }
      url.searchParams.set('client_id', 'test-client.apps.googleusercontent.com');
      url.searchParams.set('redirect_uri', params.redirect_uri || 'http://localhost/auth/google/callback');
      url.searchParams.set('response_type', params.response_type || 'code');
      return url.href;
    },
    async getToken(params) {
      calls.exchange.push(params);
      if (options.exchangeError) throw new Error('Sensitive provider error');
      return { tokens: { id_token: 'signed-test-id-token', access_token: 'never-expose-access-token' } };
    },
    async verifyIdToken(params) {
      calls.verification.push(params);
      if (options.verifyError) throw new Error('Invalid signature');
      return { getPayload: () => ({
        sub: 'google-faculty-7', email: 'faculty@example.edu', email_verified: true,
        hd: 'example.edu', nonce: calls.authorization.at(-1)?.nonce,
        aud: 'test-client.apps.googleusercontent.com', iss: 'https://accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
        ...options.claims
      }) };
    }
  };
  const db = {
    async execute(sql, values = []) {
      calls.queries.push({ sql, values });
      if (/UPDATE FacultyAccount/i.test(sql)) {
        throw new Error('Faculty login must never write to the SQL database');
      }
      if (/FROM FacultyAccount/i.test(sql)) {
        if (options.databaseError) throw new Error('Sensitive database error');
        const rows = /LOWER\s*\(/i.test(sql)
          ? faculty.filter(row => options.collationMatch || values.includes(row.Email.trim().toLowerCase()))
          : faculty.filter(row => values.includes(row.AccountID));
        return [rows.map(row => ({ ...row }))];
      }
      if (/UPDATE Project/i.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM Project/i.test(sql)) return [[{ ProjectID: 42, Approved: 0 }]];
      throw new Error(`Unexpected SQL in auth test: ${sql}`);
    }
  };
  const store = options.defaultStore ? undefined : new session.MemoryStore();
  const auth = {
    clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-client-secret',
    sessionSecret: 'test-session-secret-with-at-least-32-characters', publicOrigin: 'http://localhost',
    store, googleClient,
    ...options.auth
  };
  const app = createApp({ db, storage: {}, adminKey: 'old-api-key', auth, trustProxy: options.trustProxy });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    app.locals.authStore?.stopInterval?.();
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(url, settings = {}) {
    const response = await fetch(base + url, {
      ...settings, redirect: 'manual', headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}), ...settings.headers }
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) cookie = setCookies[0].split(';')[0];
    return response;
  }
  async function begin() {
    const response = await request('/auth/google');
    assert.equal(response.status, 302);
    return { response, url: new URL(response.headers.get('location')), cookie };
  }
  async function finish(params = {}) {
    const query = new URLSearchParams({ code: 'test-authorization-code', state: calls.authorization.at(-1).state, ...params });
    return request(`/auth/google/callback?${query}`);
  }
  async function login() {
    await begin();
    const response = await finish();
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    const state = await request('/api/auth/session');
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.authenticated, true);
    return body;
  }
  return { calls, faculty, store: app.locals.authStore, request, begin, finish, login, get cookie() { return cookie; } };
}

function invalidLogin(response) {
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?auth=invalid');
}

test('anonymous visitors have no session and cannot open the dashboard or faculty API', async t => {
  const { request, calls } = await setup(t);
  const state = await request('/api/auth/session');
  assert.deepEqual(await state.json(), { authenticated: false });
  assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.equal(state.headers.get('set-cookie'), null);
  invalidLogin(await request('/AdminDashboard.html'));
  invalidLogin(await request('/admindashboard.html'));
  for (const headers of [{}, { Authorization: 'Bearer old-api-key' }]) {
    const response = await request('/api/admin/projects', { headers });
    assert.equal(response.status, 401);
  }
  assert.equal(calls.queries.length, 0);
});

test('Google authorization uses state, nonce, and S256 PKCE with a server-side session', async t => {
  const { begin, finish, calls } = await setup(t);
  const { response, url } = await begin();
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost/auth/google/callback');
  assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), ['email', 'openid']);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state').length >= 32);
  assert.ok(url.searchParams.get('nonce').length >= 32);
  assert.notEqual(url.searchParams.get('state'), url.searchParams.get('nonce'));
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(response.headers.get('set-cookie'), /google-faculty|faculty%40|code-verifier/);
  await finish();
  assert.equal(calls.exchange.length, 1);
  assert.equal(createHash('sha256').update(calls.exchange[0].codeVerifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(calls.verification[0].audience, 'test-client.apps.googleusercontent.com');
  assert.equal(calls.verification[0].idToken, 'signed-test-id-token');
});

test('a faculty email match rotates the session and grants access without writing to SQL', async t => {
  const fixture = await setup(t, { defaultStore: true, faculty: [{ AccountID: 7, Email: ' Faculty@Example.edu ' }] });
  const { cookie: pendingCookie } = await fixture.begin();
  const result = await fixture.finish();
  assert.equal(result.status, 302);
  assert.equal(result.headers.get('location'), '/');
  assert.notEqual(fixture.cookie, pendingCookie);
  assert.deepEqual(fixture.faculty, [{ AccountID: 7, Email: ' Faculty@Example.edu ' }]);
  assert.ok(fixture.calls.queries.every(call => /^SELECT AccountID, Email FROM FacultyAccount/i.test(call.sql)));
  const state = await (await fixture.request('/api/auth/session')).json();
  assert.equal(state.authenticated, true);
  assert.equal(typeof state.csrfToken, 'string');
  assert.ok(state.csrfToken.length >= 32);
  assert.doesNotMatch(JSON.stringify(state), /never-expose|signed-test|client-secret/);
  const query = fixture.calls.queries.find(call => /LOWER\s*\(/i.test(call.sql));
  assert.ok(query.sql.includes('?'));
  assert.ok(query.values.includes('faculty@example.edu'));
  assert.equal((await fixture.request('/api/admin/projects')).status, 200);
  const dashboard = await fixture.request('/AdminDashboard.html');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  const html = await dashboard.text();
  assert.match(html, /<header[\s>]/i);
  assert.match(html, /<nav[\s>]/i);
  assert.match(html, /<main\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<\/main>/i);
  assert.equal((await fixture.request('/api/admin/projects', { headers: { Cookie: pendingCookie } })).status, 401);
});

test('missing, mismatched, and repeated OAuth state is rejected before exchanging a code', async t => {
  for (const suffix of ['?code=x', '?code=x&state=wrong', '?code=x&state=one&state=two', '?error=access_denied']) {
    await t.test(suffix, async t => {
      const { request, begin, calls } = await setup(t);
      await begin();
      invalidLogin(await request(`/auth/google/callback${suffix}`));
      assert.equal(calls.exchange.length, 0);
      assert.equal((await (await request('/api/auth/session')).json()).authenticated, false);
    });
  }
});

test('malformed authorization codes and cancellation are rejected even with a valid state', async t => {
  for (const query of ['code=one&code=two', 'code=', `code=${'x'.repeat(4097)}`, 'error=access_denied']) {
    await t.test(query.length > 100 ? 'oversized code' : query, async t => {
      const { begin, request, calls } = await setup(t);
      const { url } = await begin();
      invalidLogin(await request(`/auth/google/callback?state=${url.searchParams.get('state')}&${query}`));
      assert.equal(calls.exchange.length, 0);
    });
  }
});

test('failed Google authentication and unauthorized faculty identities return the same generic failure', async t => {
  const cases = [
    ['provider failure', { exchangeError: true }],
    ['invalid signature or audience', { verifyError: true }],
    ['unknown faculty email', { faculty: [] }],
    ['distinct address matched by MySQL collation', { collationMatch: true,
      faculty: [{ AccountID: 7, Email: 'fáculty@example.edu' }] }],
    ['duplicate faculty email', { faculty: [
      { AccountID: 7, Email: 'faculty@example.edu' },
      { AccountID: 8, Email: 'FACULTY@example.edu' }
    ] }],
    ['unverified email', { claims: { email_verified: false } }],
    ['missing Google subject', { claims: { sub: undefined } }],
    ['nonce mismatch', { claims: { nonce: 'different-login' } }],
    ['non-authoritative third-party email', { claims: { hd: undefined } }]
  ];
  for (const [name, options] of cases) {
    await t.test(name, async t => {
      const { begin, finish, request, calls } = await setup(t, options);
      await begin();
      const response = await finish();
      invalidLogin(response);
      assert.doesNotMatch(await response.text(), /Sensitive|Invalid signature|example.edu/);
      assert.equal((await (await request('/api/auth/session')).json()).authenticated, false);
      assert.equal((await request('/api/admin/projects')).status, 401);
      assert.equal(calls.queries.some(call => /UPDATE FacultyAccount/.test(call.sql)), false);
    });
  }
});

test('verified Gmail faculty accounts can sign in without a Workspace claim', async t => {
  const { login } = await setup(t, {
    faculty: [{ AccountID: 7, Email: 'faculty@gmail.com' }],
    claims: { email: 'faculty@gmail.com', hd: undefined }
  });
  await login();
});

test('a completed OAuth callback cannot be replayed with either the old or current session', async t => {
  const fixture = await setup(t);
  const { cookie: pendingCookie, url } = await fixture.begin();
  await fixture.finish();
  const authenticatedCookie = fixture.cookie;
  const callback = `/auth/google/callback?code=test-authorization-code&state=${url.searchParams.get('state')}`;
  invalidLogin(await fixture.request(callback, { headers: { Cookie: pendingCookie } }));
  assert.equal(fixture.calls.exchange.length, 1);
  invalidLogin(await fixture.request(callback, { headers: { Cookie: authenticatedCookie } }));
  assert.equal(fixture.calls.exchange.length, 1);
});

test('Google callbacks cannot authenticate a browser that did not start the login', async t => {
  const { request, calls } = await setup(t);
  invalidLogin(await request('/auth/google/callback?code=stolen-code&state=stolen-state'));
  assert.equal(calls.exchange.length, 0);
  assert.equal(calls.queries.length, 0);
});

test('faculty authentication uses the authorized email without storing Google account identifiers', async t => {
  const { login, calls, store } = await setup(t, { claims: { sub: 'another-valid-google-subject' } });
  await login();
  assert.ok(calls.queries.every(call => /^SELECT AccountID, Email FROM FacultyAccount/i.test(call.sql)));
  const sessions = await new Promise((resolve, reject) => store.all((error, data) => error ? reject(error) : resolve(data)));
  assert.doesNotMatch(JSON.stringify(sessions), /another-valid-google-subject|googleSubject|id_token|access_token/);
});

test('logout and faculty mutations require the session CSRF token and matching origin', async t => {
  const fixture = await setup(t);
  const { csrfToken } = await fixture.login();
  for (const headers of [
    { Origin: 'http://localhost' },
    { Origin: 'http://localhost', 'X-CSRF-Token': 'wrong' },
    { Origin: 'https://evil.example', 'X-CSRF-Token': csrfToken }
  ]) {
    assert.equal((await fixture.request('/auth/logout', { method: 'POST', headers })).status, 403);
    const mutation = await fixture.request('/api/admin/projects/42', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ approved: true })
    });
    assert.equal(mutation.status, 403);
  }
  assert.equal(fixture.calls.queries.some(call => /UPDATE Project/.test(call.sql)), false);
  const headers = { Origin: 'http://localhost', 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' };
  assert.equal((await fixture.request('/api/admin/projects/42', { method: 'PATCH', headers, body: JSON.stringify({ approved: true }) })).status, 200);
  const authenticatedCookie = fixture.cookie;
  const logout = await fixture.request('/auth/logout', { method: 'POST', headers });
  assert.ok([200, 204].includes(logout.status));
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/i);
  assert.equal((await (await fixture.request('/api/auth/session')).json()).authenticated, false);
  assert.equal((await fixture.request('/api/admin/projects', { headers: { Cookie: authenticatedCookie } })).status, 401);
});

test('removing, replacing, or duplicating a faculty email revokes existing sessions', async t => {
  for (const revoke of [
    rows => rows.splice(0),
    rows => { rows[0].AccountID = 8; },
    rows => { rows[0].Email = 'other@example.edu'; },
    rows => rows.push({ AccountID: 8, Email: 'FACULTY@example.edu' })
  ]) {
    await t.test(String(revoke), async t => {
      const fixture = await setup(t);
      await fixture.login();
      revoke(fixture.faculty);
      assert.equal((await fixture.request('/api/admin/projects')).status, 401);
      invalidLogin(await fixture.request('/AdminDashboard.html'));
      assert.equal((await (await fixture.request('/api/auth/session')).json()).authenticated, false);
    });
  }
});

test('altered cookies and client-supplied identity cannot grant faculty access', async t => {
  const fixture = await setup(t);
  await fixture.login();
  const last = fixture.cookie.at(-1);
  const tampered = fixture.cookie.slice(0, -1) + (last === 'a' ? 'b' : 'a');
  const response = await fixture.request('/api/admin/projects', {
    headers: { Cookie: tampered, 'X-Faculty-Email': 'faculty@example.edu', Authorization: 'Bearer old-api-key' }
  });
  assert.equal(response.status, 401);
});

test('HTML and authentication responses use defensive browser headers and never serve auth source files', async t => {
  const { request } = await setup(t);
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-powered-by'), null);
  for (const path of ['/auth.js', '/test/auth.test.js', '/session-store.js']) {
    assert.equal((await request(path)).status, 404);
  }
});

async function updateStoredSession(store, update) {
  const sessions = await new Promise((resolve, reject) => store.all((error, data) => error ? reject(error) : resolve(data)));
  const entries = Object.entries(sessions);
  assert.equal(entries.length, 1);
  const [id, data] = entries[0];
  update(data);
  await new Promise((resolve, reject) => store.set(id, data, error => error ? reject(error) : resolve()));
}

test('an expired OAuth transaction cannot exchange a code even if its cookie has not expired', async t => {
  const fixture = await setup(t);
  await fixture.begin();
  await updateStoredSession(fixture.store, data => { data.oauth.expiresAt = Date.now() - 1; });
  invalidLogin(await fixture.finish());
  assert.equal(fixture.calls.exchange.length, 0);
  assert.equal(fixture.calls.queries.length, 0);
});

test('faculty sessions expire on the server even if the browser continues sending a valid cookie', async t => {
  const fixture = await setup(t);
  await fixture.login();
  const oldCookie = fixture.cookie;
  const queriesBefore = fixture.calls.queries.length;
  await updateStoredSession(fixture.store, data => { data.faculty.expiresAt = Date.now() - 1; });
  assert.equal((await fixture.request('/api/admin/projects')).status, 401);
  assert.equal(fixture.calls.queries.length, queriesBefore);
  invalidLogin(await fixture.request('/AdminDashboard.html', { headers: { Cookie: oldCookie } }));
  assert.equal((await (await fixture.request('/api/auth/session')).json()).authenticated, false);
});

test('HTTPS deployments issue host-only Secure cookies and use the configured callback origin', async t => {
  const fixture = await setup(t, {
    auth: { publicOrigin: 'https://capstone.example.edu' }, trustProxy: 'loopback',
    headers: { 'X-Forwarded-Proto': 'https', Host: 'untrusted.example' }
  });
  const { response, url } = await fixture.begin();
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-capstone\.sid=/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Path=\//);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://capstone.example.edu/auth/google/callback');
  assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.equal((await fixture.finish()).status, 302);
  assert.equal((await (await fixture.request('/api/auth/session')).json()).authenticated, true);
});

test('spoofed proxy headers do not permit HTTP sign-in on an HTTPS deployment', async t => {
  const fixture = await setup(t, {
    auth: { publicOrigin: 'https://capstone.example.edu' }, headers: { 'X-Forwarded-Proto': 'https' }
  });
  const response = await fixture.request('/auth/google');
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(fixture.calls.authorization.length, 0);
});

test('repeated login requests are throttled before creating more OAuth transactions', async t => {
  const fixture = await setup(t);
  let limited;
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fixture.request('/auth/google');
    if (response.status === 429) { limited = response; break; }
    assert.equal(response.status, 302);
  }
  assert.ok(limited, 'Expected repeated login attempts to be rate limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const authorizationCount = fixture.calls.authorization.length;
  assert.equal((await fixture.request('/auth/google')).status, 429);
  assert.equal(fixture.calls.authorization.length, authorizationCount);
});

test('unsafe and partial production authentication configuration fails closed', () => {
  const env = {
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://capstone.example.edu',
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
    SESSION_SECRET: 'a-strong-session-secret-at-least-32-bytes-long'
  };
  assert.equal(authConfigFromEnv({}), null);
  assert.throws(() => authConfigFromEnv({ NODE_ENV: 'production' }));
  assert.throws(() => authConfigFromEnv({ GOOGLE_CLIENT_ID: 'only-one-setting' }));
  for (const override of [
    { PUBLIC_ORIGIN: 'http://localhost' }, { PUBLIC_ORIGIN: 'http://capstone.example.edu' },
    { PUBLIC_ORIGIN: 'https://capstone.example.edu/path' }, { PUBLIC_ORIGIN: 'https://user:secret@capstone.example.edu' },
    { SESSION_SECRET: 'too-short' }, { GOOGLE_CLIENT_SECRET: '' }
  ]) {
    assert.throws(() => authConfigFromEnv({ ...env, ...override }));
  }
  const auth = authConfigFromEnv(env);
  assert.equal(auth.production, true);
  assert.equal(auth.redirectUri, 'https://capstone.example.edu/auth/google/callback');
  assert.equal(authConfigFromEnv({ ...env, GOOGLE_REDIRECT_URI: auth.redirectUri }).redirectUri, auth.redirectUri);
  for (const redirectUri of ['https://other.example/auth/google/callback', 'https://capstone.example.edu/wrong-path', 'https://capstone.example.edu/auth/google/callback?next=evil']) {
    assert.throws(() => authConfigFromEnv({ ...env, GOOGLE_REDIRECT_URI: redirectUri }), /GOOGLE_REDIRECT_URI/);
  }
  assert.throws(() => createApp({ db: {}, storage: {}, auth: { ...auth, store: new session.MemoryStore() } }), /bounded session store/);
});

function storeCall(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

test('the default session store expires and revokes sessions without extending their absolute deadline', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = createSessionStore();
  t.after(() => store.stopInterval());
  const data = { cookie: { maxAge: 86400000 }, faculty: { expiresAt: now + 1000 } };
  await storeCall(store, 'set', 'opaque-id', data);
  assert.deepEqual(await storeCall(store, 'get', 'opaque-id'), data);
  now += 900;
  await storeCall(store, 'touch', 'opaque-id', data);
  now += 101;
  assert.equal(await storeCall(store, 'get', 'opaque-id'), undefined);
  const fresh = { cookie: {}, faculty: { expiresAt: now + 1000 } };
  await storeCall(store, 'set', 'opaque-id', fresh);
  await storeCall(store, 'destroy', 'opaque-id');
  assert.equal(await storeCall(store, 'get', 'opaque-id'), undefined);
});

test('the default session store starts empty after a restart and has a fixed capacity', async t => {
  const first = createSessionStore();
  const restarted = createSessionStore();
  t.after(() => { first.stopInterval(); restarted.stopInterval(); });
  const data = { cookie: {}, faculty: { expiresAt: Date.now() + 60000 } };
  await storeCall(first, 'set', 'previous-session', data);
  assert.equal(await storeCall(restarted, 'get', 'previous-session'), undefined);
  for (let index = 0; index <= 10000; index++) first.set(`session-${index}`, data);
  assert.equal(await storeCall(first, 'length'), 10000);
  assert.equal(await storeCall(first, 'get', 'previous-session'), undefined);
  assert.equal(await storeCall(first, 'get', 'session-0'), undefined);
  assert.deepEqual(await storeCall(first, 'get', 'session-10000'), data);
});

