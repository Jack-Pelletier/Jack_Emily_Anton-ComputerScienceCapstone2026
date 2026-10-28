const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const session = require('express-session');
const { createApp } = require('../server');

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
const project = {
  ProjectID: 42, ProjectName: 'Campus map', ProjectDescription: 'Find campus buildings.',
  Industry: 'Education', Approved: 0, Keywords: ['Maps', 'Campus'], PDFID: 5
};
const storedPdf = {
  PDFID: 5, ProjectID: 42, PDFBucket: 'project-pdfs', PDFPath: '42/previous.pdf',
  PDFOriginalName: 'previous.pdf', UploadedAt: '2026-10-01T00:00:00.000Z'
};

function pdfForm(contents = pdf, name = 'replacement.pdf') {
  const form = new FormData();
  if (contents !== null) form.append('projectFile', new Blob([contents], { type: 'application/pdf' }), name);
  return form;
}

// Run actual HTTP/session/CSRF handling with deterministic service boundaries.
// Transactions record their ordering so storage can never be deleted before a
// database commit, and rollback/failure paths do not require a real bucket.
async function setup(t, options = {}) {
  const calls = { queries: [], events: [], uploads: [], removals: [], connections: 0 };
  const cleanup = (options.cleanup || []).map(job => ({ ...job }));
  async function execute(sql, values = []) {
    if (/FROM FacultyAccount/i.test(sql)) return [[{ AccountID: 1, Email: 'faculty@example.edu' }]];
    calls.queries.push({ sql, values });
    if (options.failSql && sql.includes(options.failSql)) throw new Error('Private database failure');
    if (options.read) {
      const result = options.read(sql, values);
      if (result !== undefined) return [result];
    }
    if (/^\s*INSERT.*PDFCleanup/i.test(sql)) {
      cleanup.push({ CleanupID: Math.max(0, ...cleanup.map(job => job.CleanupID)) + 1, PDFBucket: values[0], PDFPath: values[1] });
      return [{ insertId: cleanup.length, affectedRows: 1 }];
    }
    if (/^\s*SELECT[\s\S]*FROM PDFCleanup/i.test(sql)) {
      const selected = /WHERE PDFBucket/i.test(sql)
        ? cleanup.filter(row => row.PDFBucket === values[0] && row.PDFPath === values[1])
        : cleanup;
      return [selected.map(row => ({ ...row }))];
    }
    if (/^\s*DELETE FROM PDFCleanup/i.test(sql)) {
      const index = cleanup.findIndex(row => row.CleanupID === values[0]);
      if (index >= 0) cleanup.splice(index, 1);
      return [{ affectedRows: 1 }];
    }
    // Project list/detail SELECTs contain PDF and keyword scalar subqueries.
    if (/^\s*SELECT[\s\S]*FROM Project\b/i.test(sql)) {
      return [options.missingProject ? [] : [{ ...project, Keywords: [...project.Keywords] }]];
    }
    if (/^\s*SELECT[\s\S]*FROM ProjectPDF/i.test(sql)) {
      return [/SELECT PDFID, PDFOriginalName, UploadedAt/i.test(sql)
        ? [{ PDFID: storedPdf.PDFID, PDFOriginalName: storedPdf.PDFOriginalName, UploadedAt: storedPdf.UploadedAt }]
        : [{ ...storedPdf }]];
    }
    if (/^\s*SELECT[\s\S]*FROM StudentWebsites/i.test(sql)) return [[
      { StudentID: 7, WebsiteName: 'GitHub', WebsiteURL: 'https://github.com/student' },
      { StudentID: 7, WebsiteName: 'LinkedIn', WebsiteURL: 'https://linkedin.com/in/student' }
    ]];
    if (/^\s*SELECT[\s\S]*FROM StudentInfo/i.test(sql)) return [[{
      StudentID: 7, ProjectID: 42, StudentName: 'Student', StudentEmail: 'student@example.edu',
      StudentPhoneNumber: '555-123-4567', StudentInfoPublic: 0,
      WebsiteName: 'GitHub', WebsiteURL: 'https://github.com/student'
    }, {
      StudentID: 7, ProjectID: 42, StudentName: 'Student', StudentEmail: 'student@example.edu',
      StudentPhoneNumber: '555-123-4567', StudentInfoPublic: 0,
      WebsiteName: 'LinkedIn', WebsiteURL: 'https://linkedin.com/in/student'
    }]];
    if (/^\s*SELECT[\s\S]*FROM (?:ProjectKeywords|Keywords)/i.test(sql) && !/FROM Project\s/i.test(sql)) {
      return [[{ KeywordName: 'Campus' }, { KeywordName: 'Maps' }]];
    }
    if (/^\s*INSERT INTO StudentInfo/i.test(sql)) return [{ insertId: 8, affectedRows: 1 }];
    return [{ insertId: 12, affectedRows: options.missingProject ? 0 : 1 }];
  }
  const connection = {
    execute,
    async beginTransaction() { calls.events.push('begin'); },
    async commit() {
      calls.events.push('commit');
      if (options.failCommit) throw new Error('Commit connection lost');
    },
    async rollback() { calls.events.push('rollback'); },
    release() { calls.events.push('release'); }
  };
  const db = { execute, async getConnection() { calls.connections++; return connection; } };
  const storage = {
    from(bucket) {
      return {
        async upload(path, contents, settings) {
          calls.events.push('upload');
          calls.uploads.push({ bucket, path, contents, settings });
          return { error: options.failUpload ? new Error('Private storage failure') : null };
        },
        async remove(paths) {
          calls.events.push('remove');
          calls.removals.push({ bucket, paths });
          return { error: options.failRemove ? new Error('Private storage failure') : null };
        }
      };
    }
  };
  let nonce;
  const auth = {
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
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, settings = {}) => fetch(base + url, { redirect: 'manual', ...settings });
  async function signIn() {
    const start = await request('/auth/google');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/auth/google/callback?code=test-code&state=${state}`, {
      headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] }
    });
    assert.equal(callback.headers.get('location'), '/');
    const Cookie = callback.headers.getSetCookie()[0].split(';')[0];
    const result = await (await request('/api/auth/session', { headers: { Cookie } })).json();
    return { Cookie, Origin: 'http://localhost', 'X-CSRF-Token': result.csrfToken };
  }
  return { calls, cleanup, request, signIn };
}

test('admin project reads and writes reject anonymous callers before service access', async t => {
  const { request, calls } = await setup(t);
  for (const [url, method] of [
    ['/api/admin/projects', 'GET'], ['/api/admin/projects/42', 'GET'],
    ['/api/admin/projects/42', 'PATCH'], ['/api/admin/projects/42', 'DELETE'],
    ['/api/admin/projects/42/pdf', 'PUT']
  ]) assert.equal((await request(url, { method })).status, 401, `${method} ${url}`);
  assert.deepEqual(calls.queries, []);
  assert.equal(calls.connections, 0);
  assert.deepEqual(calls.uploads, []);
});

test('every admin project mutation rejects missing CSRF tokens and foreign origins', async t => {
  const { request, signIn, calls } = await setup(t);
  const headers = await signIn();
  for (const badHeaders of [{ Cookie: headers.Cookie }, { ...headers, Origin: 'https://evil.example' }]) {
    for (const [suffix, method] of [['', 'PATCH'], ['', 'DELETE'], ['/pdf', 'PUT']]) {
      const response = await request(`/api/admin/projects/42${suffix}`, { method, headers: badHeaders });
      assert.equal(response.status, 403, method);
    }
  }
  assert.deepEqual(calls.queries, []);
  assert.equal(calls.connections, 0);
  assert.deepEqual(calls.uploads, []);
});

test('admin listing supports pending, approved, and all with parameterized search', async t => {
  for (const status of ['pending', 'approved', 'all']) {
    await t.test(status, async t => {
      const { request, signIn, calls } = await setup(t);
      const search = "campus' OR 1=1 --";
      const response = await request(`/api/admin/projects?status=${status}&search=${encodeURIComponent(search)}`, { headers: await signIn() });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body[0].ProjectID, 42);
      assert.equal(body[0].Approved, false);
      assert.equal(body[0].Keywords, 'Campus, Maps');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const query = calls.queries.at(-1);
      assert.ok(query.values.includes(`%${search}%`));
      assert.ok(!query.sql.includes(search));
      if (status === 'pending') assert.match(query.sql, /Approved\s*=\s*FALSE/i);
      if (status === 'approved') assert.match(query.sql, /Approved\s*=\s*TRUE/i);
      if (status === 'all') assert.doesNotMatch(query.sql, /Approved\s*=/i);
    });
  }
});

test('project filters and IDs reject malformed inputs before queries', async t => {
  const { request, signIn, calls } = await setup(t);
  const headers = await signIn();
  for (const url of [
    '/api/admin/projects?status=unknown', '/api/admin/projects?status=pending&status=all',
    '/api/admin/projects?search=a&search=b', `/api/admin/projects?search=${'x'.repeat(201)}`,
    '/api/admin/projects/0', '/api/admin/projects/-1', '/api/admin/projects/42oops'
  ]) assert.equal((await request(url, { headers })).status, 400, url);
  assert.deepEqual(calls.queries, []);
});

test('project details include editable tags, private contacts, and PDF metadata', async t => {
  const { request, signIn } = await setup(t);
  const response = await request('/api/admin/projects/42', { headers: await signIn() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ProjectID, 42);
  assert.equal(body.Approved, false);
  assert.deepEqual(body.keywords, ['Campus', 'Maps']);
  assert.equal(body.contacts.length, 1);
  assert.equal(body.contacts[0].StudentID, 7);
  assert.equal(body.contacts[0].contactEmail, 'student@example.edu');
  assert.equal(body.contacts[0].contactGithub, 'https://github.com/student');
  assert.equal(body.contacts[0].contactLinkedin, 'https://linkedin.com/in/student');
  assert.equal(body.pdfs[0].PDFOriginalName, 'previous.pdf');
  assert.equal(body.pdfs[0].url, '/api/projects/42/pdf');
  assert.equal(body.pdfs[0].PDFPath, undefined);
  assert.equal(body.pdfs[0].PDFBucket, undefined);
});

test('project edits validate every supplied field before a transaction', async t => {
  const invalid = [null, [], {}, { unexpected: true }, { projectTitle: '' },
    { projectTitle: 'x'.repeat(501) }, { projectAbstract: '  ' }, { projectAbstract: 'x'.repeat(2001) },
    { projectIndustry: 'x'.repeat(101) }, { projectIndustry: null }, { approved: 'true' },
    { projectTags: ['Maps'] }, { projectTags: Array.from({ length: 21 }, (_, i) => `tag${i}`).join(',') },
    { contacts: {} }, { contacts: [null] }, { contacts: [{ unexpected: 'value' }] },
    { contacts: Array.from({ length: 21 }, () => ({ contactName: 'Student' })) },
    { contacts: [{ contactEmail: 'invalid' }] }, { contacts: [{ contactName: 'x'.repeat(151) }] },
    { contacts: [{ contactPhone: 'x'.repeat(15) }] }, { contacts: [{ contactGithub: 'javascript:alert(1)' }] }
  ];
  const { request, signIn, calls } = await setup(t);
  const headers = { ...await signIn(), 'Content-Type': 'application/json' };
  for (const body of invalid) {
    const response = await request('/api/admin/projects/42', { method: 'PATCH', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(calls.connections, 0);
  assert.deepEqual(calls.queries, []);
});

test('project edits atomically update metadata, approval, deduplicated tags, and contacts', async t => {
  const { request, signIn, calls } = await setup(t);
  const headers = { ...await signIn(), 'Content-Type': 'application/json' };
  const response = await request('/api/admin/projects/42', { method: 'PATCH', headers, body: JSON.stringify({
    projectTitle: ' New map ', projectAbstract: ' Updated abstract ', projectIndustry: '', approved: true,
    projectTags: ' Maps, maps, Education ', contacts: [{ contactName: 'New student', contactEmail: 'student@example.edu', contactGithub: 'github.com/student' }]
  }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.events, ['begin', 'commit', 'release']);
  assert.ok(calls.queries.some(query => /FROM Project\b[\s\S]*FOR UPDATE/i.test(query.sql)));
  const update = calls.queries.find(query => /^UPDATE Project\b/i.test(query.sql));
  assert.ok(update.values.includes('New map'));
  assert.ok(update.values.includes('Updated abstract'));
  assert.ok(update.values.includes(null));
  assert.ok(update.values.includes(true));
  assert.equal(update.values.at(-1), 42);
  const keywords = calls.queries.filter(query => /INSERT INTO Keywords/i.test(query.sql));
  assert.deepEqual(keywords.map(query => query.values[0].toLowerCase()), ['maps', 'education']);
  assert.ok(calls.queries.some(query => /DELETE FROM ProjectKeywords/i.test(query.sql)));
  assert.ok(calls.queries.some(query => /DELETE[\s\S]*StudentWebsites/i.test(query.sql)));
  assert.ok(calls.queries.some(query => /DELETE FROM StudentInfo/i.test(query.sql)));
  assert.ok(calls.queries.some(query => /INSERT INTO StudentInfo/i.test(query.sql) && /FALSE/i.test(query.sql)));
  assert.ok(calls.queries.some(query => /INSERT INTO StudentWebsites/i.test(query.sql) && query.values.includes('https://github.com/student')));
});

test('omitted collections remain untouched and explicit empty collections clear them', async t => {
  for (const clear of [false, true]) {
    await t.test(clear ? 'clear collections' : 'preserve collections', async t => {
      const { request, signIn, calls } = await setup(t);
      const headers = { ...await signIn(), 'Content-Type': 'application/json' };
      const body = clear ? { projectTags: '', contacts: [] } : { projectTitle: 'New title' };
      assert.equal((await request('/api/admin/projects/42', { method: 'PATCH', headers, body: JSON.stringify(body) })).status, 200);
      assert.equal(calls.queries.some(query => /DELETE FROM ProjectKeywords/i.test(query.sql)), clear);
      assert.equal(calls.queries.some(query => /DELETE FROM StudentInfo/i.test(query.sql)), clear);
      assert.equal(calls.queries.some(query => /INSERT INTO StudentInfo|INSERT INTO Keywords/i.test(query.sql)), false);
    });
  }
});

test('a valid twenty-contact edit larger than 16 KB fits the admin JSON request limit', async t => {
  const { request, signIn, calls } = await setup(t);
  const headers = { ...await signIn(), 'Content-Type': 'application/json' };
  const body = JSON.stringify({ contacts: Array.from({ length: 20 }, (_, index) => ({
    contactName: `Student ${index + 1}`, contactEmail: `student${index + 1}@example.edu`,
    contactGithub: `https://github.com/student/${'x'.repeat(450)}`,
    contactLinkedin: `https://linkedin.com/in/student/${'y'.repeat(450)}`
  })) });
  assert.ok(Buffer.byteLength(body) > 16 * 1024);
  assert.ok(Buffer.byteLength(body) < 64 * 1024);
  const response = await request('/api/admin/projects/42', { method: 'PATCH', headers, body });
  assert.equal(response.status, 200);
  assert.equal(calls.queries.filter(query => /INSERT INTO StudentInfo/i.test(query.sql)).length, 20);
  assert.deepEqual(calls.events, ['begin', 'commit', 'release']);
});

test('failed edits roll back all related changes', async t => {
  t.mock.method(console, 'error', () => {});
  const { request, signIn, calls } = await setup(t, { failSql: 'INSERT INTO StudentInfo' });
  const headers = { ...await signIn(), 'Content-Type': 'application/json' };
  const response = await request('/api/admin/projects/42', { method: 'PATCH', headers, body: JSON.stringify({
    projectTitle: 'New title', projectTags: 'New tag', contacts: [{ contactName: 'New student' }]
  }) });
  assert.equal(response.status, 500);
  assert.deepEqual(calls.events, ['begin', 'rollback', 'release']);
  assert.doesNotMatch(await response.text(), /Private/);
});

test('missing projects return 404 for details, edits, deletion, and replacement without storage writes', async t => {
  const { request, signIn, calls } = await setup(t, { missingProject: true });
  const headers = await signIn();
  for (const [url, options] of [
    ['/api/admin/projects/42', {}],
    ['/api/admin/projects/42', { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectTitle: 'Missing' }) }],
    ['/api/admin/projects/42', { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }) }],
    ['/api/admin/projects/42', { method: 'DELETE' }],
    ['/api/admin/projects/42/pdf', { method: 'PUT', body: pdfForm() }]
  ]) assert.equal((await request(url, { headers, ...options })).status, 404);
  assert.deepEqual(calls.uploads, []);
  assert.deepEqual(calls.removals, []);
  assert.ok(!calls.events.includes('commit'));
});

test('project deletion queues PDFs and removes dependent rows before committing and cleaning storage', async t => {
  const { request, signIn, calls, cleanup } = await setup(t);
  const response = await request('/api/admin/projects/42', { method: 'DELETE', headers: await signIn() });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pdfCleanupPending, false);
  assert.ok(calls.queries.some(query => /INSERT.*PDFCleanup/i.test(query.sql)));
  for (const table of ['StudentWebsites', 'StudentInfo', 'ProjectKeywords', 'ProjectPDF', 'Project']) {
    assert.ok(calls.queries.some(query => new RegExp(`DELETE[\\s\\S]*\\b${table}\\b`, 'i').test(query.sql)), table);
  }
  assert.ok(calls.events.indexOf('commit') < calls.events.indexOf('remove'));
  assert.deepEqual(calls.removals, [{ bucket: 'project-pdfs', paths: ['42/previous.pdf'] }]);
  assert.deepEqual(cleanup, []);
});

test('a failed project deletion rolls back without deleting PDF storage', async t => {
  t.mock.method(console, 'error', () => {});
  const { request, signIn, calls } = await setup(t, { failSql: 'DELETE FROM StudentInfo' });
  const response = await request('/api/admin/projects/42', { method: 'DELETE', headers: await signIn() });
  assert.equal(response.status, 500);
  assert.deepEqual(calls.events, ['begin', 'rollback', 'release']);
  assert.deepEqual(calls.removals, []);
});

test('a project deletion only processes its own PDFs when unrelated cleanup jobs are pending', async t => {
  const unrelated = { CleanupID: 1, PDFBucket: 'other-bucket', PDFPath: '99/unrelated.pdf' };
  const { request, signIn, calls, cleanup } = await setup(t, { cleanup: [unrelated] });
  const response = await request('/api/admin/projects/42', { method: 'DELETE', headers: await signIn() });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pdfCleanupPending, false);
  assert.deepEqual(calls.removals, [{ bucket: 'project-pdfs', paths: ['42/previous.pdf'] }]);
  assert.deepEqual(cleanup, [unrelated]);
});

test('storage deletion failure leaves a durable cleanup job after project deletion succeeds', async t => {
  t.mock.method(console, 'error', () => {});
  const { request, signIn, calls, cleanup } = await setup(t, { failRemove: true });
  const response = await request('/api/admin/projects/42', { method: 'DELETE', headers: await signIn() });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pdfCleanupPending, true);
  assert.equal(cleanup.length, 1);
  assert.ok(calls.events.includes('commit'));
  assert.ok(!calls.events.includes('rollback'));
  assert.ok(!calls.queries.some(query => /DELETE FROM PDFCleanup/i.test(query.sql)));
});

test('replacement PDFs are validated before database and storage writes', async t => {
  const { request, signIn, calls } = await setup(t);
  const headers = await signIn();
  for (const body of [pdfForm(null), pdfForm('not a PDF'), pdfForm(pdf, 'replacement.txt')]) {
    assert.equal((await request('/api/admin/projects/42/pdf', { method: 'PUT', headers, body })).status, 400);
  }
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  pdf.copy(oversized);
  assert.equal((await request('/api/admin/projects/42/pdf', { method: 'PUT', headers, body: pdfForm(oversized) })).status, 413);
  assert.equal(calls.connections, 0);
  assert.deepEqual(calls.uploads, []);
});

test('PDF replacement commits the new reference before deleting the old object', async t => {
  const { request, signIn, calls, cleanup } = await setup(t);
  const response = await request('/api/admin/projects/42/pdf', { method: 'PUT', headers: await signIn(), body: pdfForm() });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pdfCleanupPending, false);
  assert.equal(calls.uploads.length, 1);
  assert.match(calls.uploads[0].path, /^42\/[a-f\d-]+\.pdf$/);
  assert.deepEqual(calls.uploads[0].settings, { contentType: 'application/pdf', upsert: false });
  const insert = calls.queries.find(query => /INSERT INTO ProjectPDF/i.test(query.sql));
  assert.ok(insert.values.includes(calls.uploads[0].path));
  assert.ok(insert.values.includes('replacement.pdf'));
  assert.ok(calls.events.indexOf('commit') < calls.events.indexOf('remove'));
  assert.deepEqual(calls.removals, [{ bucket: 'project-pdfs', paths: ['42/previous.pdf'] }]);
  assert.deepEqual(cleanup, []);
});

test('replacement database failure removes only the new uploaded object', async t => {
  t.mock.method(console, 'error', () => {});
  const { request, signIn, calls } = await setup(t, { failSql: 'INSERT INTO ProjectPDF' });
  const response = await request('/api/admin/projects/42/pdf', { method: 'PUT', headers: await signIn(), body: pdfForm() });
  assert.equal(response.status, 500);
  assert.ok(calls.events.includes('rollback'));
  assert.ok(!calls.events.includes('commit'));
  assert.deepEqual(calls.removals, [{ bucket: 'project-pdfs', paths: [calls.uploads[0].path] }]);
});

test('replacement storage failure keeps the existing PDF and returns a readable upstream error', async t => {
  const { request, signIn, calls } = await setup(t, { failUpload: true });
  const response = await request('/api/admin/projects/42/pdf', { method: 'PUT', headers: await signIn(), body: pdfForm() });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /Private/);
  assert.ok(calls.events.includes('rollback'));
  assert.ok(!calls.events.includes('commit'));
  assert.ok(!calls.queries.some(query => /DELETE FROM ProjectPDF|INSERT.*PDFCleanup/i.test(query.sql)));
  assert.deepEqual(calls.removals, [{ bucket: 'project-pdfs', paths: [calls.uploads[0].path] }]);
});

test('ambiguous replacement commit preserves both PDF objects for reconciliation', async t => {
  t.mock.method(console, 'error', () => {});
  const { request, signIn, calls } = await setup(t, { failCommit: true });
  const response = await request('/api/admin/projects/42/pdf', { method: 'PUT', headers: await signIn(), body: pdfForm() });
  assert.equal(response.status, 500);
  assert.ok(calls.events.includes('commit'));
  assert.deepEqual(calls.removals, []);
});
