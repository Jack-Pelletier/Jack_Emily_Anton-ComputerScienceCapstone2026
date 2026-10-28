const test = require('node:test');
const assert = require('node:assert/strict');
const { flushPdfCleanup, cleanupPending } = require('../pdf-cleanup');

function services(initialJobs) {
  const jobs = initialJobs.map(job => ({ ...job }));
  const calls = [];
  const failures = new Set();
  let failDelete = false;
  const db = {
    async execute(sql, values = []) {
      if (/^SELECT/i.test(sql)) {
        const selected = /WHERE PDFBucket/i.test(sql)
          ? jobs.filter(job => job.PDFBucket === values[0] && job.PDFPath === values[1])
          : jobs.filter(job => job.CleanupID > (values[0] || 0)).sort((a, b) => a.CleanupID - b.CleanupID).slice(0, 100);
        return [selected.map(job => ({ ...job }))];
      }
      if (/^DELETE/i.test(sql)) {
        calls.push({ type: 'deleteJob', id: values[0] });
        if (failDelete) throw new Error('Database unavailable');
        const index = jobs.findIndex(job => job.CleanupID === values[0]);
        if (index >= 0) jobs.splice(index, 1);
        return [{ affectedRows: index >= 0 ? 1 : 0 }];
      }
      throw new Error(`Unexpected cleanup query: ${sql}`);
    }
  };
  const storage = {
    from(bucket) {
      return {
        async remove(paths) {
          calls.push({ type: 'removeFile', bucket, paths });
          return { error: failures.has(paths[0]) ? new Error('Storage unavailable') : null };
        }
      };
    }
  };
  return { db, storage, jobs, calls, failures, set failDelete(value) { failDelete = value; } };
}

function job(id) {
  return { CleanupID: id, PDFBucket: 'project-pdfs', PDFPath: `${id}/old.pdf` };
}

test('cleanup retains failed removals durably and retries them successfully on a later pass', async t => {
  t.mock.method(console, 'error', () => {});
  const fixture = services([job(1)]);
  fixture.failures.add('1/old.pdf');
  await flushPdfCleanup(fixture.db, fixture.storage);
  assert.deepEqual(fixture.jobs, [job(1)]);
  assert.deepEqual(fixture.calls, [{ type: 'removeFile', bucket: 'project-pdfs', paths: ['1/old.pdf'] }]);
  fixture.failures.clear();
  await flushPdfCleanup(fixture.db, fixture.storage);
  assert.deepEqual(fixture.jobs, []);
  assert.deepEqual(fixture.calls.slice(1), [
    { type: 'removeFile', bucket: 'project-pdfs', paths: ['1/old.pdf'] },
    { type: 'deleteJob', id: 1 }
  ]);
});

test('a failure to remove the completed database job is safely retried after file removal', async t => {
  t.mock.method(console, 'error', () => {});
  const fixture = services([job(2)]);
  fixture.failDelete = true;
  await flushPdfCleanup(fixture.db, fixture.storage);
  assert.deepEqual(fixture.jobs, [job(2)]);
  fixture.failDelete = false;
  await flushPdfCleanup(fixture.db, fixture.storage);
  assert.deepEqual(fixture.jobs, []);
  assert.deepEqual(fixture.calls.map(call => call.type), ['removeFile', 'deleteJob', 'removeFile', 'deleteJob']);
});

test('a full batch of failed jobs does not prevent later jobs from being processed', async t => {
  t.mock.method(console, 'error', () => {});
  const fixture = services(Array.from({ length: 101 }, (_, index) => job(index + 1)));
  for (let id = 1; id <= 100; id++) fixture.failures.add(`${id}/old.pdf`);
  const cursor = await flushPdfCleanup(fixture.db, fixture.storage);
  assert.equal(fixture.jobs.length, 101);
  assert.equal(cursor, 100);
  await flushPdfCleanup(fixture.db, fixture.storage, cursor);
  assert.equal(fixture.jobs.length, 100);
  assert.ok(!fixture.jobs.some(queued => queued.CleanupID === 101));
  assert.equal(await flushPdfCleanup(fixture.db, fixture.storage, 101), 0);
});

test('immediate cleanup reports pending status only for the requested files', async t => {
  t.mock.method(console, 'error', () => {});
  const fixture = services([job(1), job(2)]);
  fixture.failures.add('1/old.pdf');
  assert.equal(await cleanupPending(fixture.db, fixture.storage, [job(2)]), false);
  assert.deepEqual(fixture.jobs, [job(1)]);
  assert.deepEqual(fixture.calls, [
    { type: 'removeFile', bucket: 'project-pdfs', paths: ['2/old.pdf'] },
    { type: 'deleteJob', id: 2 }
  ]);
  assert.equal(await cleanupPending(fixture.db, fixture.storage, [job(1)]), true);
  assert.deepEqual(fixture.jobs, [job(1)]);
});
