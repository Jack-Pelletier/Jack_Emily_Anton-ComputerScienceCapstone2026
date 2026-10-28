const fieldLabels = {
  projectTitle: 'Project title', projectAbstract: 'Abstract', projectIndustry: 'Industry',
  projectTags: 'Keywords', contactName: 'Name', contactEmail: 'Email',
  contactPhone: 'Phone number', contactLinkedin: 'LinkedIn', contactGithub: 'GitHub', search: 'Search'
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function readText(body, name, maxLength, required = false) {
  const value = body[name] === undefined ? '' : body[name];
  const label = fieldLabels[name] || name;
  if (typeof value !== 'string') throw badRequest(`${label} must be text.`);
  const text = value.trim();
  if (required && !text) throw badRequest(`${label} is required.`);
  if (text.length > maxLength) throw badRequest(`${label} is too long (maximum ${maxLength} characters).`);
  return text;
}

function readWebsite(body, name) {
  let value = readText(body, name, 500);
  if (!value) return '';
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') ||
        url.username || url.password || value.length > 500) throw new Error();
  } catch {
    throw badRequest(`${fieldLabels[name]} must be a valid http or https link.`);
  }
  return value;
}

function projectId(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw badRequest('Invalid project ID.');
  return Number(value);
}

function readKeywords(body) {
  const tags = readText(body, 'projectTags', 2099).split(',').map(tag => tag.trim()).filter(Boolean);
  const keywords = [...new Map(tags.map(tag => [tag.toLowerCase(), tag])).values()];
  if (keywords.length > 20 || keywords.some(tag => tag.length > 100)) {
    throw badRequest('Use up to 20 keywords, with no more than 100 characters each.');
  }
  return keywords;
}

const contactFields = ['contactName', 'contactEmail', 'contactPhone', 'contactLinkedin', 'contactGithub'];
function readContact(body) {
  const contact = {
    contactName: readText(body, 'contactName', 150), contactEmail: readText(body, 'contactEmail', 100),
    contactPhone: readText(body, 'contactPhone', 14), contactLinkedin: readWebsite(body, 'contactLinkedin'),
    contactGithub: readWebsite(body, 'contactGithub')
  };
  if (contact.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.contactEmail)) {
    throw badRequest('Enter a valid email address.');
  }
  return contact;
}

function validatePdf(file) {
  if (!file || !/\.pdf$/i.test(file.originalname) || file.buffer.subarray(0, 5).toString() !== '%PDF-') {
    throw badRequest('Choose a PDF file.');
  }
  if (file.originalname.length > 225) throw badRequest('The PDF filename must be 225 characters or fewer.');
}

async function saveKeywords(connection, id, keywords) {
  for (const keyword of keywords) {
    await connection.execute(
      'INSERT INTO Keywords (KeywordName) VALUES (?) ON DUPLICATE KEY UPDATE KeywordID = LAST_INSERT_ID(KeywordID)', [keyword]
    );
    await connection.execute(
      `INSERT IGNORE INTO ProjectKeywords (ProjectID, KeywordID)
       SELECT ?, KeywordID FROM Keywords WHERE KeywordName = ?`, [id, keyword]
    );
  }
}

async function saveContact(connection, id, contact) {
  if (!Object.values(contact).some(Boolean)) return;
  const [student] = await connection.execute(
    `INSERT INTO StudentInfo (ProjectID, StudentName, StudentEmail, StudentPhoneNumber, StudentInfoPublic)
     VALUES (?, ?, ?, ?, FALSE)`,
    [id, contact.contactName || null, contact.contactEmail || null, contact.contactPhone || null]
  );
  for (const [label, url] of [['LinkedIn', contact.contactLinkedin], ['GitHub', contact.contactGithub]]) {
    if (url) await connection.execute(
      'INSERT INTO StudentWebsites (StudentID, WebsiteName, WebsiteURL) VALUES (?, ?, ?)', [student.insertId, label, url]
    );
  }
}

module.exports = { badRequest, readText, projectId, readKeywords, readContact, contactFields, validatePdf, saveKeywords, saveContact };
