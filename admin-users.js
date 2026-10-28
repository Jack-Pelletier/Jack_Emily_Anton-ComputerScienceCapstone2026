function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function accountId(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw requestError(400, 'Invalid user ID.');
  }
  return Number(value);
}

function readEmail(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => key !== 'email') || typeof body.email !== 'string') {
    throw requestError(400, 'Send a JSON object containing only email.');
  }
  const email = body.email.trim().toLowerCase();
  if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw requestError(400, 'Enter a valid email address of 100 characters or fewer.');
  }
  return email;
}

// Lock the allowlist in a consistent order for every write. Recheck the caller
// after acquiring the locks: another administrator may have just removed them.
async function changeUsers(db, faculty, change) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [users] = await connection.execute(
      'SELECT AccountID, Email FROM FacultyAccount ORDER BY AccountID FOR UPDATE'
    );
    if (!users.some(user => user.AccountID === faculty.AccountID &&
        user.Email?.trim().toLowerCase() === faculty.Email.trim().toLowerCase())) {
      throw requestError(401, 'Faculty login required.');
    }
    const result = await change(connection, users);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { console.error('Could not roll back the user transaction.'); }
    if (error.code === 'ER_DUP_ENTRY') throw requestError(409, 'That email is already in the user list.');
    throw error;
  } finally {
    connection.release();
  }
}

// Install after the faculty session and CSRF middleware for /api/admin.
function installAdminUserRoutes(app, { db }) {
  app.get('/api/admin/users', async (req, res) => {
    const [users] = await db.execute('SELECT AccountID, Email FROM FacultyAccount ORDER BY Email, AccountID');
    res.json(users.map(user => ({
      AccountID: user.AccountID, Email: user.Email,
      isCurrentUser: user.AccountID === req.faculty.AccountID
    })));
  });

  app.post('/api/admin/users', async (req, res) => {
    const email = readEmail(req.body);
    const user = await changeUsers(db, req.faculty, async (connection, users) => {
      if (users.some(user => user.Email?.trim().toLowerCase() === email)) {
        throw requestError(409, 'That email is already in the user list.');
      }
      const [result] = await connection.execute('INSERT INTO FacultyAccount (Email) VALUES (?)', [email]);
      return { AccountID: result.insertId, Email: email };
    });
    res.status(201).json(user);
  });

  app.delete('/api/admin/users/:id', async (req, res) => {
    const id = accountId(req.params.id);
    if (id === req.faculty.AccountID) {
      throw requestError(409, 'You cannot remove your own user account.');
    }
    await changeUsers(db, req.faculty, async (connection, users) => {
      if (!users.some(user => user.AccountID === id)) throw requestError(404, 'User not found.');
      await connection.execute('DELETE FROM FacultyAccount WHERE AccountID = ?', [id]);
    });
    res.json({ message: 'User removed. Their administrator access has been revoked.' });
  });
}

module.exports = { installAdminUserRoutes };
