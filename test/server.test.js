const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../server');
const session = require('express-session');

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

function submission(fields = {}, file = { name: 'project.pdf', contents: pdf }) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    projectTitle: 'Street Map', projectAbstract: 'A campus mapping project.', ...fields
  })) {
    if (value !== null) form.append(key, value);
  }
  if (file) form.append('projectFile', new Blob([file.contents], { type: 'application/pdf' }), file.name);
  return form;
}

// Exercise the real HTTP routes, but keep tests independent of MySQL and Supabase.
async function setup(t, options = {}) {
  const calls = { connections: 0, queries: [], transaction: [], uploads: [], removals: [], signed: [] };
  const connection = {
    async beginTransaction() { calls.transaction.push('begin'); },
    async execute(sql, values) {
      calls.queries.push({ sql, values });
      if (options.failSql && sql.includes(options.failSql)) throw new Error('Internal database failure');
      return [{ insertId: sql.includes('INSERT INTO StudentInfo') ? 7 : 42 }];
    },
    async commit() {
      calls.transaction.push('commit');
      if (options.failCommit) throw new Error('Connection lost during commit');
    },
    async rollback() { calls.transaction.push('rollback'); },
    release() { calls.transaction.push('release'); }
  };
  const db = {
    async getConnection() { calls.connections++; return connection; },
    async execute(sql, values) {
      if (sql.includes('FROM FacultyAccount')) {
        return [[{ AccountID: 1, Email: 'faculty@example.edu' }]];
      }
      calls.queries.push({ sql, values });
      return [options.read ? options.read(sql, values) : []];
    }
  };
  const storage = {
    from(bucket) {
      return {
        async upload(path, contents, settings) {
          calls.uploads.push({ bucket, path, contents, settings });
          return { error: options.failUpload ? new Error('Internal storage failure') : null };
        },
        async remove(paths) {
          calls.removals.push({ bucket, paths });
          return { error: null };
        },
        async createSignedUrl(path, seconds) {
          calls.signed.push({ bucket, path, seconds });
          return options.failSignedUrl
            ? { error: new Error('Storage unavailable') }
            : { data: { signedUrl: 'https://storage.example.com/project.pdf?token=temporary' }, error: null };
        }
      };
    }
  };
  let nonce;
  const auth = options.disableAuth ? null : {
    clientId: 'test-client', clientSecret: 'test-secret', publicOrigin: 'http://localhost',
    sessionSecret: 'test-only-session-secret-with-more-than-32-bytes', store: new session.MemoryStore(),
    googleClient: {
      generateAuthUrl(params) { nonce = params.nonce; return `https://accounts.google.com/?state=${params.state}`; },
      async getToken() { return { tokens: { id_token: 'test-token' } }; },
      async verifyIdToken() { return { getPayload: () => ({ sub: 'faculty-subject', email: 'faculty@example.edu', email_verified: true, hd: 'example.edu', nonce }) }; }
    }
  };
  const app = createApp({ db, storage, bucket: 'project-pdfs', auth });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, settings) => fetch(base + url, settings);
  async function signIn() {
    const start = await request('/auth/google', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/auth/google/callback?code=test-code&state=${state}`, {
      redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] }
    });
    assert.equal(callback.headers.get('location'), '/');
    const Cookie = callback.headers.getSetCookie()[0].split(';')[0];
    const result = await (await request('/api/auth/session', { headers: { Cookie } })).json();
    return { Cookie, Origin: 'http://localhost', 'X-CSRF-Token': result.csrfToken };
  }
  return { calls, request, signIn };
}

test('anonymous submission saves a PDF and project without a contact row', async t => {
  const { calls, request } = await setup(t);
  const response = await request('/api/projects', { method: 'POST', body: submission() });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { projectId: 42, message: 'Project submitted for faculty review.' });
  assert.deepEqual(calls.transaction, ['begin', 'commit', 'release']);
  assert.equal(calls.uploads.length, 1);
  assert.match(calls.uploads[0].path, /^42\/[a-f\d-]+\.pdf$/);
  assert.deepEqual(calls.uploads[0].settings, { contentType: 'application/pdf', upsert: false });
  const project = calls.queries.find(query => query.sql.startsWith('INSERT INTO Project ('));
  assert.deepEqual(project.values, ['Street Map', 'A campus mapping project.', null]);
  const storedPdf = calls.queries.find(query => query.sql.startsWith('INSERT INTO ProjectPDF'));
  assert.deepEqual(storedPdf.values, [42, 'project-pdfs', calls.uploads[0].path, 'project.pdf']);
  assert.equal(calls.queries.some(query => query.sql.includes('INSERT INTO StudentInfo')), false);
  assert.deepEqual(calls.removals, []);
});

test('optional contacts stay private and duplicate keywords are stored once', async t => {
  const { calls, request } = await setup(t);
  const response = await request('/api/projects', {
    method: 'POST', body: submission({
      projectIndustry: 'Education', projectTags: ' JavaScript, javascript, Maps, ',
      contactName: 'Student', contactEmail: 'student@example.com', contactPhone: '555-123-4567',
      contactLinkedin: 'linkedin.com/in/student', contactGithub: 'https://github.com/student'
    })
  });
  assert.equal(response.status, 201);
  const keywords = calls.queries.filter(query => query.sql.startsWith('INSERT INTO Keywords'));
  assert.equal(keywords.length, 2);
  assert.deepEqual(keywords.map(query => query.values[0].toLowerCase()), ['javascript', 'maps']);
  const contact = calls.queries.find(query => query.sql.includes('INSERT INTO StudentInfo'));
  assert.match(contact.sql, /FALSE/);
  assert.deepEqual(contact.values, [42, 'Student', 'student@example.com', '555-123-4567']);
  const websites = calls.queries.filter(query => query.sql.includes('INSERT INTO StudentWebsites'));
  assert.deepEqual(websites.map(query => query.values), [
    [7, 'LinkedIn', 'https://linkedin.com/in/student'], [7, 'GitHub', 'https://github.com/student']
  ]);
});

test('invalid submissions are rejected before database or storage writes', async t => {
  const cases = [
    ['missing title', () => submission({ projectTitle: null })],
    ['blank abstract', () => submission({ projectAbstract: '   ' })],
    ['long title', () => submission({ projectTitle: 'x'.repeat(501) })],
    ['long abstract', () => submission({ projectAbstract: 'x'.repeat(2001) })],
    ['long industry', () => submission({ projectIndustry: 'x'.repeat(101) })],
    ['long keyword', () => submission({ projectTags: 'x'.repeat(101) })],
    ['too many keywords', () => submission({ projectTags: Array.from({ length: 21 }, (_, i) => `tag${i}`).join(',') })],
    ['invalid email', () => submission({ contactEmail: 'invalid' })],
    ['unsafe website', () => submission({ contactGithub: 'javascript:alert(1)' })],
    ['missing PDF', () => submission({}, null)],
    ['wrong extension', () => submission({}, { name: 'project.txt', contents: pdf })],
    ['wrong PDF contents', () => submission({}, { name: 'project.pdf', contents: 'plain text' })],
    ['long filename', () => submission({}, { name: 'x'.repeat(222) + '.pdf', contents: pdf })],
    ['repeated title', () => { const form = submission(); form.append('projectTitle', 'Another title'); return form; }],
    ['unexpected file', () => { const form = submission(); form.append('otherFile', new Blob([pdf]), 'other.pdf'); return form; }]
  ];
  for (const [name, makeBody] of cases) {
    await t.test(name, async t => {
      const { calls, request } = await setup(t);
      const response = await request('/api/projects', { method: 'POST', body: makeBody() });
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, 'string');
      assert.equal(calls.connections, 0);
      assert.deepEqual(calls.uploads, []);
    });
  }
});

test('a PDF larger than 10 MB is rejected before writes', async t => {
  const { calls, request } = await setup(t);
  const contents = Buffer.alloc(10 * 1024 * 1024 + 1);
  pdf.copy(contents);
  const response = await request('/api/projects', {
    method: 'POST', body: submission({}, { name: 'large.pdf', contents })
  });
  assert.equal(response.status, 413);
  assert.equal(calls.connections, 0);
  assert.deepEqual(calls.uploads, []);
});

test('database failure rolls back, removes the uploaded PDF, and releases the connection', async t => {
  t.mock.method(console, 'error', () => {});
  const { calls, request } = await setup(t, { failSql: 'INSERT INTO ProjectPDF' });
  const response = await request('/api/projects', { method: 'POST', body: submission() });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Something went wrong. Please try again.' });
  assert.deepEqual(calls.transaction, ['begin', 'rollback', 'release']);
  assert.deepEqual(calls.removals, [{ bucket: 'project-pdfs', paths: [calls.uploads[0].path] }]);
});

test('an unconfirmed commit preserves the PDF for reconciliation', async t => {
  t.mock.method(console, 'error', () => {});
  const { calls, request } = await setup(t, { failCommit: true });
  const response = await request('/api/projects', { method: 'POST', body: submission() });
  assert.equal(response.status, 500);
  assert.deepEqual(calls.transaction, ['begin', 'commit', 'rollback', 'release']);
  assert.equal(calls.uploads.length, 1);
  assert.deepEqual(calls.removals, []);
});

test('storage failure rolls back and attempts cleanup without exposing provider errors', async t => {
  const { calls, request } = await setup(t, { failUpload: true });
  const response = await request('/api/projects', { method: 'POST', body: submission() });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'PDF storage is unavailable. Please try again.' });
  assert.deepEqual(calls.transaction, ['begin', 'rollback', 'release']);
  assert.deepEqual(calls.removals, [{ bucket: 'project-pdfs', paths: [calls.uploads[0].path] }]);
  assert.equal(calls.queries.some(query => query.sql.includes('INSERT INTO ProjectPDF')), false);
});

test('public search requests approved projects with parameterized search and no contact fields', async t => {
  const keywords = Array.from({ length: 20 }, (_, i) => `Topic ${String(i).padStart(2, '0')} ${'x'.repeat(70)}`);
  const expectedKeywords = keywords.join(', ');
  const project = { ProjectID: 42, ProjectName: 'Street Map', ProjectDescription: 'Mapping', Industry: 'Education', Keywords: [...keywords].reverse(), PDFID: 1 };
  const { request } = await setup(t, {
    read(sql, values) {
      assert.match(sql, /WHERE p\.Approved = TRUE AND/);
      assert.match(sql, /JSON_ARRAYAGG/);
      assert.doesNotMatch(sql, /StudentInfo|StudentEmail|StudentPhoneNumber|SELECT \*/);
      assert.deepEqual(values, Array(4).fill("%maps' OR 1=1 --%"));
      return [project];
    }
  });
  const response = await request(`/api/projects?search=${encodeURIComponent("maps' OR 1=1 --")}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(expectedKeywords.length > 1024);
  assert.deepEqual(await response.json(), [{ ...project, Keywords: expectedKeywords }]);
});

test('faculty routes require a faculty session before reading or changing data', async t => {
  const { calls, request, signIn } = await setup(t, { read: () => [{ ProjectID: 42, Approved: 0 }] });
  for (const [url, method] of [['/api/admin/projects', 'GET'], ['/api/admin/projects/42', 'GET'], ['/api/admin/projects/42', 'PATCH']]) {
    const response = await request(url, { method, headers: { Authorization: 'Bearer wrong-key' } });
    assert.equal(response.status, 401);
  }
  assert.deepEqual(calls.queries, []);
  const authorized = await request('/api/admin/projects', { headers: await signIn() });
  assert.equal(authorized.status, 200);
  assert.match(calls.queries[0].sql, /Approved = FALSE/);
});

test('faculty access is disabled when login is not configured', async t => {
  const { calls, request } = await setup(t, { disableAuth: true });
  const response = await request('/api/admin/projects', { headers: { Authorization: 'Bearer faculty-test-key' } });
  assert.equal(response.status, 401);
  assert.deepEqual(calls.queries, []);
});

test('approval accepts a boolean and updates only the requested project', async t => {
  const { calls, request, signIn } = await setup(t, { read: () => ({ affectedRows: 1 }) });
  const headers = { ...await signIn(), 'Content-Type': 'application/json' };
  const invalid = await request('/api/admin/projects/42', { method: 'PATCH', headers, body: JSON.stringify({ approved: 'true' }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(calls.queries, []);
  const approved = await request('/api/admin/projects/42', { method: 'PATCH', headers, body: JSON.stringify({ approved: true }) });
  assert.equal(approved.status, 200);
  assert.deepEqual(calls.queries[0], { sql: 'UPDATE Project SET Approved = ? WHERE ProjectID = ?', values: [true, 42] });
});

test('approved PDFs redirect to short-lived signed URLs', async t => {
  const { calls, request } = await setup(t, {
    read(sql, values) {
      assert.match(sql, /p\.Approved = TRUE OR \? = TRUE/);
      assert.deepEqual(values, [42, false]);
      return [{ PDFBucket: 'project-pdfs', PDFPath: '42/file.pdf' }];
    }
  });
  const response = await request('/api/projects/42/pdf', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://storage.example.com/project.pdf?token=temporary');
  assert.deepEqual(calls.signed, [{ bucket: 'project-pdfs', path: '42/file.pdf', seconds: 60 }]);
});

test('pending PDFs are hidden publicly and accessible to faculty', async t => {
  const { calls, request, signIn } = await setup(t, {
    read(sql, values) { return values[1] ? [{ PDFBucket: 'project-pdfs', PDFPath: '42/pending.pdf' }] : []; }
  });
  const publicResponse = await request('/api/projects/42/pdf', { redirect: 'manual' });
  assert.equal(publicResponse.status, 404);
  assert.deepEqual(calls.signed, []);
  const facultyResponse = await request('/api/projects/42/pdf', { headers: await signIn(), redirect: 'manual' });
  assert.equal(facultyResponse.status, 302);
  assert.equal(calls.signed.length, 1);
});

test('PDF signing failure returns a readable error and invalid IDs never reach MySQL', async t => {
  const { calls, request } = await setup(t, {
    failSignedUrl: true, read: () => [{ PDFBucket: 'project-pdfs', PDFPath: '42/file.pdf' }]
  });
  const invalid = await request('/api/projects/42oops/pdf');
  assert.equal(invalid.status, 400);
  assert.deepEqual(calls.queries, []);
  const response = await request('/api/projects/42/pdf');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'The PDF could not be opened. Please try again.' });
});

test('public pages work while local source and configuration stay inaccessible', async t => {
  const { request } = await setup(t);
  for (const url of ['/', '/home.html', '/upload.html', '/projects.html', '/about.html', '/style.css', '/script.js', '/auth-ui.js', '/images/CapstoneStreetLogo.png']) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    await response.arrayBuffer();
  }
  for (const url of [
    '/server.js', '/test/server.test.js', '/auth.js', '/test/auth.test.js', '/.env', '/.env.local', '/.env.example',
    '/test/admin-projects.test.js', '/test/admin-users.test.js', '/test/pdf-cleanup.test.js',
    '/DBCreation.sql', '/package.json', '/package-lock.json', '/settings.json', '/Readme', '/.git/config',
    '/node_modules/express/package.json', '/migrations/001-dev-faculty-accounts.sql',
    '/images/.env', '/images/.git/config', '/images/%2e%2e%2f.env', '/images/%2e%2e%2fserver.js',
    '/images/%2e%2e%2fauth.js', '/images/%2e%2e%2fAdminDashboard.html', '/images/%252e%252e%252f.env'
  ]) {
    const response = await request(url);
    assert.equal(response.status, 404, url);
    assert.deepEqual(await response.json(), { error: 'Not found.' });
  }
});
