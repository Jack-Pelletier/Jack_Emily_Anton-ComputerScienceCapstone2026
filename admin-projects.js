const { randomUUID } = require('node:crypto');
const { badRequest, readText, projectId, readKeywords, readContact, contactFields,
  validatePdf, saveKeywords, saveContact } = require('./project-data');
const { queuePdfCleanup, cleanupPending } = require('./pdf-cleanup');

const projectSelection = `SELECT p.ProjectID, p.ProjectName, p.ProjectDescription, p.Industry, p.Approved,
  (SELECT JSON_ARRAYAGG(k.KeywordName) FROM ProjectKeywords pk
   JOIN Keywords k ON k.KeywordID = pk.KeywordID WHERE pk.ProjectID = p.ProjectID) AS Keywords,
  (SELECT MIN(pdf.PDFID) FROM ProjectPDF pdf WHERE pdf.ProjectID = p.ProjectID) AS PDFID
  FROM Project p`;

function formatProject(project) {
  const keywords = (typeof project.Keywords === 'string' ? JSON.parse(project.Keywords) : project.Keywords) || [];
  keywords.sort((a, b) => a.localeCompare(b));
  return { ...project, Approved: Boolean(project.Approved), Keywords: keywords.join(', ') };
}

function validatePatch(body) {
  const allowed = ['projectTitle', 'projectAbstract', 'projectIndustry', 'projectTags', 'approved', 'contacts'];
  if (!body || Array.isArray(body) || typeof body !== 'object' || !Object.keys(body).length ||
      Object.keys(body).some(key => !allowed.includes(key))) throw badRequest('Send one or more supported project fields.');
  const updates = [];
  for (const [field, column, length, required] of [
    ['projectTitle', 'ProjectName', 500, true], ['projectAbstract', 'ProjectDescription', 2000, true],
    ['projectIndustry', 'Industry', 100, false]
  ]) {
    if (Object.hasOwn(body, field)) updates.push([column, readText(body, field, length, required) || null]);
  }
  if (Object.hasOwn(body, 'approved')) {
    if (typeof body.approved !== 'boolean') throw badRequest('approved must be true or false.');
    updates.push(['Approved', body.approved]);
  }
  const keywords = Object.hasOwn(body, 'projectTags') ? readKeywords(body) : undefined;
  let contacts;
  if (Object.hasOwn(body, 'contacts')) {
    if (!Array.isArray(body.contacts) || body.contacts.length > 20) throw badRequest('contacts must be an array of up to 20 contacts.');
    contacts = body.contacts.map(contact => {
      if (!contact || Array.isArray(contact) || typeof contact !== 'object' ||
          Object.keys(contact).some(key => !contactFields.includes(key))) throw badRequest('Invalid contact fields.');
      const value = readContact(contact);
      if (!Object.values(value).some(Boolean)) throw badRequest('Each contact must contain at least one value.');
      return value;
    });
  }
  return { updates, keywords, contacts };
}

async function lockProject(connection, id) {
  const [projects] = await connection.execute('SELECT ProjectID FROM Project WHERE ProjectID = ? FOR UPDATE', [id]);
  if (!projects.length) throw Object.assign(new Error('Project not found.'), { status: 404 });
}

async function deleteContacts(connection, id) {
  await connection.execute(`DELETE w FROM StudentWebsites w
    JOIN StudentInfo s ON s.StudentID = w.StudentID WHERE s.ProjectID = ?`, [id]);
  await connection.execute('DELETE FROM StudentInfo WHERE ProjectID = ?', [id]);
}

async function transaction(db, work) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const value = await work(connection);
    await connection.commit();
    return value;
  } catch (error) {
    try { await connection.rollback(); } catch { console.error('Could not roll back the project transaction.'); }
    throw error;
  } finally { connection.release(); }
}

function installAdminProjectRoutes(app, { db, storage, bucket, upload }) {
  app.get('/api/admin/projects', async (req, res) => {
    const status = req.query.status ?? 'pending';
    if (!['pending', 'approved', 'all'].includes(status)) throw badRequest('status must be pending, approved, or all.');
    const search = readText(req.query, 'search', 200);
    const pattern = `%${search}%`;
    const filter = status === 'all' ? 'TRUE' : `p.Approved = ${status === 'approved' ? 'TRUE' : 'FALSE'}`;
    const [projects] = await db.execute(`${projectSelection} WHERE ${filter} AND
      (p.ProjectName LIKE ? OR p.ProjectDescription LIKE ? OR p.Industry LIKE ? OR EXISTS (
        SELECT 1 FROM ProjectKeywords pk JOIN Keywords k ON k.KeywordID = pk.KeywordID
        WHERE pk.ProjectID = p.ProjectID AND k.KeywordName LIKE ?)) ORDER BY p.ProjectID DESC`,
    [pattern, pattern, pattern, pattern]);
    res.json(projects.map(formatProject));
  });

  app.get('/api/admin/projects/:id', async (req, res) => {
    const id = projectId(req.params.id);
    // One consistent snapshot, so a simultaneous edit/delete cannot mix old and new fields.
    const detail = await transaction(db, async connection => {
      const [projects] = await connection.execute(`${projectSelection} WHERE p.ProjectID = ?`, [id]);
      if (!projects.length) throw Object.assign(new Error('Project not found.'), { status: 404 });
      const [students] = await connection.execute(`SELECT s.StudentID, s.StudentName, s.StudentEmail,
        s.StudentPhoneNumber, w.WebsiteName, w.WebsiteURL FROM StudentInfo s
        LEFT JOIN StudentWebsites w ON w.StudentID = s.StudentID WHERE s.ProjectID = ? ORDER BY s.StudentID, w.WebsiteID`, [id]);
      const contacts = new Map();
      for (const row of students) {
        if (!contacts.has(row.StudentID)) contacts.set(row.StudentID, {
          StudentID: row.StudentID, contactName: row.StudentName || '', contactEmail: row.StudentEmail || '',
          contactPhone: row.StudentPhoneNumber || '', contactLinkedin: '', contactGithub: ''
        });
        const contact = contacts.get(row.StudentID);
        if (row.WebsiteName === 'LinkedIn') contact.contactLinkedin = row.WebsiteURL;
        if (row.WebsiteName === 'GitHub') contact.contactGithub = row.WebsiteURL;
      }
      const [pdfs] = await connection.execute(
        'SELECT PDFID, PDFOriginalName, UploadedAt FROM ProjectPDF WHERE ProjectID = ? ORDER BY PDFID', [id]
      );
      const project = formatProject(projects[0]);
      const rawKeywords = projects[0].Keywords;
      const keywords = (typeof rawKeywords === 'string' ? JSON.parse(rawKeywords) : rawKeywords) || [];
      return { ...project, keywords: keywords.sort((a, b) => a.localeCompare(b)), contacts: [...contacts.values()],
        pdfs: pdfs.map(pdf => ({ ...pdf, url: `/api/projects/${id}/pdf` })) };
    });
    res.json(detail);
  });

  app.patch('/api/admin/projects/:id', async (req, res) => {
    const id = projectId(req.params.id);
    const { updates, keywords, contacts } = validatePatch(req.body);
    // Keep the existing approval API, including its response, for frontend callers.
    if (Object.keys(req.body).length === 1 && Object.hasOwn(req.body, 'approved')) {
      const [result] = await db.execute('UPDATE Project SET Approved = ? WHERE ProjectID = ?', [req.body.approved, id]);
      if (!result.affectedRows) return res.status(404).json({ error: 'Project not found.' });
      return res.json({ message: req.body.approved ? 'Project approved.' : 'Project hidden from public view.' });
    }
    await transaction(db, async connection => {
      await lockProject(connection, id);
      if (updates.length) await connection.execute(
        `UPDATE Project SET ${updates.map(([column]) => `${column} = ?`).join(', ')} WHERE ProjectID = ?`,
        [...updates.map(([, value]) => value), id]
      );
      if (keywords !== undefined) {
        await connection.execute('DELETE FROM ProjectKeywords WHERE ProjectID = ?', [id]);
        await saveKeywords(connection, id, keywords);
      }
      if (contacts !== undefined) {
        await deleteContacts(connection, id);
        for (const contact of contacts) await saveContact(connection, id, contact);
      }
    });
    res.json({ message: 'Project updated.' });
  });

  app.delete('/api/admin/projects/:id', async (req, res) => {
    const id = projectId(req.params.id);
    const files = await transaction(db, async connection => {
      await lockProject(connection, id);
      const [files] = await connection.execute('SELECT PDFBucket, PDFPath FROM ProjectPDF WHERE ProjectID = ?', [id]);
      await queuePdfCleanup(connection, files);
      await deleteContacts(connection, id);
      await connection.execute('DELETE FROM ProjectKeywords WHERE ProjectID = ?', [id]);
      await connection.execute('DELETE FROM ProjectPDF WHERE ProjectID = ?', [id]);
      await connection.execute('DELETE FROM Project WHERE ProjectID = ?', [id]);
      return files;
    });
    res.json({ message: 'Project deleted.', pdfCleanupPending: await cleanupPending(db, storage, files) });
  });

  app.put('/api/admin/projects/:id/pdf', upload.single('projectFile'), async (req, res) => {
    const id = projectId(req.params.id);
    validatePdf(req.file);
    if (Object.keys(req.body || {}).length) throw badRequest('Send only the projectFile PDF.');
    const connection = await db.getConnection();
    let pdfPath;
    let committing = false;
    let oldFiles;
    try {
      await connection.beginTransaction();
      await lockProject(connection, id);
      [oldFiles] = await connection.execute('SELECT PDFBucket, PDFPath FROM ProjectPDF WHERE ProjectID = ?', [id]);
      pdfPath = `${id}/${randomUUID()}.pdf`;
      const { error } = await storage.from(bucket).upload(pdfPath, req.file.buffer, { contentType: 'application/pdf', upsert: false });
      if (error) throw Object.assign(new Error('PDF storage is unavailable. Please try again.'), { status: 502 });
      await queuePdfCleanup(connection, oldFiles);
      await connection.execute('DELETE FROM ProjectPDF WHERE ProjectID = ?', [id]);
      await connection.execute('INSERT INTO ProjectPDF (ProjectID, PDFBucket, PDFPath, PDFOriginalName) VALUES (?, ?, ?, ?)',
        [id, bucket, pdfPath, req.file.originalname]);
      committing = true;
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch { console.error('Could not roll back the PDF replacement.'); }
      if (pdfPath && !committing) {
        try {
          const { error } = await storage.from(bucket).remove([pdfPath]);
          if (error) throw error;
        } catch { console.error(`Could not remove unused PDF: ${bucket}/${pdfPath}`); }
      } else if (pdfPath) {
        console.error(`Check project ${id} and PDF ${bucket}/${pdfPath}; commit could not be confirmed.`);
      }
      throw error;
    } finally { connection.release(); }
    res.json({ message: 'Project PDF replaced.', pdfCleanupPending: await cleanupPending(db, storage, oldFiles) });
  });
}

module.exports = { installAdminProjectRoutes };
