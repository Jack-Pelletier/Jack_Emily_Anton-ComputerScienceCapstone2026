const express = require('express');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const helmet = require('helmet');
const { installFacultyAuth, authConfigFromEnv } = require('./auth');

const { readText, projectId, readKeywords, readContact, validatePdf, saveKeywords, saveContact } = require('./project-data');
const { installAdminUserRoutes } = require('./admin-users');
const { installAdminProjectRoutes } = require('./admin-projects');
const { startPdfCleanup } = require('./pdf-cleanup');

// Passing the clients in also lets the tests run without a live database or bucket.
function createApp({ db, storage, bucket = 'project-pdfs', auth = null, trustProxy = false }) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
        imgSrc: ["'self'"], connectSrc: ["'self'"], formAction: ["'self'"],
        frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'none'"],
        upgradeInsecureRequests: auth?.publicOrigin?.startsWith('https:') ? [] : null
      }
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: auth?.publicOrigin?.startsWith('https:') ? { maxAge: 31536000 } : false
  }));
  if (auth?.publicOrigin?.startsWith('https:')) {
    app.use((req, res, next) => {
      if (!req.secure) return res.status(400).send('HTTPS is required. Check the trusted proxy configuration.');
      next();
    });
  }
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const facultyAuth = installFacultyAuth(app, { db, auth });

  // Only these public files are served. The server, SQL, and .env stay private.
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'Home.html')));
  for (const file of ['Home.html', 'Projects.html', 'Upload.html', 'About.html', 'style.css', 'script.js', 'auth-ui.js']) {
    app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, file)));
  }
  app.get('/AdminDashboard.html', facultyAuth.loadFaculty, facultyAuth.requirePage,
    (req, res) => res.sendFile(path.join(__dirname, 'AdminDashboard.html')));
  app.use('/images', express.static(path.join(__dirname, 'Images')));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 12, parts: 13, fieldSize: 8000 }
  });

  app.post('/api/projects', upload.single('projectFile'), async (req, res) => {
    const body = req.body || {};
    const title = readText(body, 'projectTitle', 500, true);
    const abstract = readText(body, 'projectAbstract', 2000, true);
    const industry = readText(body, 'projectIndustry', 100);
    const keywords = readKeywords(body);
    const contact = readContact(body);
    const file = req.file;
    validatePdf(file);

    const connection = await db.getConnection();
    let pdfPath;
    let committing = false;
    let savedId;
    try {
      await connection.beginTransaction();
      const [project] = await connection.execute(
        'INSERT INTO Project (ProjectName, ProjectDescription, Industry) VALUES (?, ?, ?)',
        [title, abstract, industry || null]
      );
      savedId = project.insertId;
      pdfPath = `${savedId}/${randomUUID()}.pdf`;
      const { error } = await storage.from(bucket).upload(pdfPath, file.buffer, {
        contentType: 'application/pdf', upsert: false
      });
      if (error) throw Object.assign(new Error('PDF storage is unavailable. Please try again.'), { status: 502 });
      await connection.execute(
        'INSERT INTO ProjectPDF (ProjectID, PDFBucket, PDFPath, PDFOriginalName) VALUES (?, ?, ?, ?)',
        [savedId, bucket, pdfPath, file.originalname]
      );

      await saveKeywords(connection, savedId, keywords);
      await saveContact(connection, savedId, contact);
      committing = true;
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch { console.error('Could not roll back the project transaction.'); }
      // A lost connection during commit may mean MySQL already saved the row.
      // Keep that PDF for inspection instead of deleting a possibly referenced file.
      if (pdfPath && !committing) {
        try {
          const cleanup = await storage.from(bucket).remove([pdfPath]);
          if (cleanup.error) throw cleanup.error;
        } catch {
          console.error(`Could not remove unused PDF: ${bucket}/${pdfPath}`);
        }
      } else if (pdfPath) {
        console.error(`Check project ${savedId} and PDF ${bucket}/${pdfPath}; commit could not be confirmed.`);
      }
      throw error;
    } finally {
      connection.release();
    }
    res.status(201).json({ projectId: savedId, message: 'Project submitted for faculty review.' });
  });

  app.get('/api/projects', async (req, res) => {
    const search = readText(req.query, 'search', 200);
    const pattern = `%${search}%`;
    const [projects] = await db.execute(
      `SELECT p.ProjectID, p.ProjectName, p.ProjectDescription, p.Industry,
         (SELECT JSON_ARRAYAGG(k.KeywordName)
          FROM ProjectKeywords pk JOIN Keywords k ON k.KeywordID = pk.KeywordID
          WHERE pk.ProjectID = p.ProjectID) AS Keywords,
         (SELECT MIN(pdf.PDFID) FROM ProjectPDF pdf WHERE pdf.ProjectID = p.ProjectID) AS PDFID
       FROM Project p
       WHERE p.Approved = TRUE AND
         (p.ProjectName LIKE ? OR p.ProjectDescription LIKE ? OR p.Industry LIKE ? OR EXISTS (
           SELECT 1 FROM ProjectKeywords pk JOIN Keywords k ON k.KeywordID = pk.KeywordID
           WHERE pk.ProjectID = p.ProjectID AND k.KeywordName LIKE ?))
       ORDER BY p.ProjectID DESC`, [pattern, pattern, pattern, pattern]
    );
    for (const project of projects) {
      project.Keywords = (project.Keywords || []).sort((a, b) => a.localeCompare(b)).join(', ');
    }
    res.json(projects);
  });

  app.get('/api/projects/:id/pdf', facultyAuth.loadFaculty, async (req, res) => {
    const [files] = await db.execute(
      `SELECT pdf.PDFBucket, pdf.PDFPath FROM ProjectPDF pdf
       JOIN Project p ON p.ProjectID = pdf.ProjectID
       WHERE p.ProjectID = ? AND (p.Approved = TRUE OR ? = TRUE)
       ORDER BY pdf.PDFID LIMIT 1`, [projectId(req.params.id), Boolean(req.faculty)]
    );
    if (!files.length) return res.status(404).json({ error: 'PDF not found.' });
    const file = files[0];
    const { data, error } = await storage.from(file.PDFBucket).createSignedUrl(file.PDFPath, 60);
    if (error || !data?.signedUrl) {
      return res.status(502).json({ error: 'The PDF could not be opened. Please try again.' });
    }
    res.redirect(data.signedUrl);
  });

  app.use('/api/admin', facultyAuth.loadFaculty, facultyAuth.requireFaculty, facultyAuth.requireCsrf);

  installAdminUserRoutes(app, { db });
  installAdminProjectRoutes(app, { db, storage, bucket, upload });

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (req.path.toLowerCase().startsWith('/auth/google')) {
      console.error('Authentication request failed.');
      return res.redirect('/?auth=invalid');
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'PDF files must be 10 MB or smaller.' : 'Invalid upload. Send one PDF and the project form fields.';
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if ([400, 401, 404, 409, 502].includes(error.status)) return res.status(error.status).json({ error: error.message });
    console.error('Request failed:', error.code || error.name);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

async function start() {
  const envFile = path.join(__dirname, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const auth = authConfigFromEnv(env);
  const trustProxy = env.TRUST_PROXY ? env.TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean) : false;
  if (trustProxy && trustProxy.some(value => /^(true|false|\d+)$/i.test(value))) {
    throw new Error('TRUST_PROXY must list specific trusted proxy IP addresses or CIDR ranges.');
  }
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    if (!env[key]) throw new Error(`Missing ${key}. Copy .env.example to .env and fill in your settings.`);
  }
  const port = Number(env.PORT || 3000);
  const dbPort = Number(env.DB_PORT || 3306);
  if (![port, dbPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) {
    throw new Error('PORT and DB_PORT must be numbers between 1 and 65535.');
  }
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const db = mysql.createPool({
    host: env.DB_HOST, port: dbPort, user: env.DB_USER, password: env.DB_PASSWORD || '',
    database: env.DB_NAME, connectionLimit: 5, charset: 'utf8mb4'
  });
  try {
    await db.execute('SELECT Industry, Approved FROM Project LIMIT 0');
    await db.execute('SELECT AccountID, Email, NormalizedEmail FROM FacultyAccount LIMIT 0');
    await db.execute('SELECT CleanupID, PDFBucket, PDFPath FROM PDFCleanup LIMIT 0');
  } catch (error) {
    await db.end();
    throw new Error(`MySQL is not ready (${error.code}). Check .env and the database setup in Readme.`);
  }
  const app = createApp({ db, storage: supabase.storage, bucket: env.SUPABASE_BUCKET || 'project-pdfs', auth, trustProxy });
  const server = app.listen(port, () => console.log(`Capstone Street is running at http://localhost:${port}`));
  const stopCleanup = startPdfCleanup(db, supabase.storage);
  server.once('close', stopCleanup);
  server.on('error', async error => {
    console.error(`Server could not start (${error.code}).`);
    stopCleanup();
    app.locals.authStore?.stopInterval?.();
    await db.end();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(async () => { app.locals.authStore?.stopInterval?.(); await db.end(); }));
  }
}

if (require.main === module) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { createApp };
