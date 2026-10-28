// Queue removals in the same transaction that removes their database references.
// A storage outage cannot restore a deleted project or lose track of its files.
async function queuePdfCleanup(connection, files) {
  for (const file of files) {
    await connection.execute(
      'INSERT IGNORE INTO PDFCleanup (PDFBucket, PDFPath) VALUES (?, ?)', [file.PDFBucket, file.PDFPath]
    );
  }
}

async function removeJobs(db, storage, jobs) {
  for (const job of jobs) {
    try {
      const { error } = await storage.from(job.PDFBucket).remove([job.PDFPath]);
      if (error) throw error;
      await db.execute('DELETE FROM PDFCleanup WHERE CleanupID = ?', [job.CleanupID]);
    } catch {
      // Leave the durable job in place for the next pass, including after restart.
      console.error(`PDF cleanup pending for job ${job.CleanupID}.`);
    }
  }
}

async function flushPdfCleanup(db, storage, afterId = 0) {
  const [jobs] = await db.execute('SELECT CleanupID, PDFBucket, PDFPath FROM PDFCleanup WHERE CleanupID > ? ORDER BY CleanupID LIMIT 100', [afterId]);
  await removeJobs(db, storage, jobs);
  return jobs.at(-1)?.CleanupID || 0;
}

async function cleanupPending(db, storage, files) {
  if (!files.length) return false;
  try {
    // A request only waits for its own files, regardless of the background backlog.
    for (const file of files) {
      const [jobs] = await db.execute('SELECT CleanupID, PDFBucket, PDFPath FROM PDFCleanup WHERE PDFBucket = ? AND PDFPath = ?',
        [file.PDFBucket, file.PDFPath]);
      await removeJobs(db, storage, jobs);
    }
    for (const file of files) {
      const [jobs] = await db.execute('SELECT CleanupID FROM PDFCleanup WHERE PDFBucket = ? AND PDFPath = ?',
        [file.PDFBucket, file.PDFPath]);
      if (jobs.length) return true;
    }
    return false;
  } catch {
    console.error('PDF cleanup will be retried.');
    return true;
  }
}

function startPdfCleanup(db, storage) {
  let running = false;
  let afterId = 0;
  const run = async () => {
    if (running) return;
    running = true;
    // Cycle through the queue so repeatedly failing jobs cannot starve later ones.
    try { afterId = await flushPdfCleanup(db, storage, afterId); }
    catch { console.error('Could not read the PDF cleanup queue.'); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(run, 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { queuePdfCleanup, cleanupPending, flushPdfCleanup, startPdfCleanup };
