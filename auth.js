const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const { OAuth2Client } = require('google-auth-library');
const { rateLimit } = require('express-rate-limit');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const LOGIN_TTL = 10 * 60 * 1000;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const randomToken = () => randomBytes(32).toString('base64url');
const sessionCall = (req, method) => new Promise((resolve, reject) => {
  req.session[method](error => error ? reject(error) : resolve());
});

function equalSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Sessions stay on this server, outside MySQL. The browser gets only an opaque ID.
// Bound memory usage and expire entries even when the browser never returns.
function createSessionStore() {
  return new MemoryStore({
    max: 10000,
    checkPeriod: 60 * 1000,
    ttl: (options, data) => {
      const expiresAt = data.faculty?.expiresAt || data.oauth?.expiresAt;
      return Number.isFinite(expiresAt)
        ? Math.max(1, Math.min(SESSION_TTL, expiresAt - Date.now()))
        : LOGIN_TTL;
    }
  });
}

function validateConfig(config) {
  const requiredSettings = {
    clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET',
    sessionSecret: 'SESSION_SECRET', publicOrigin: 'PUBLIC_ORIGIN'
  };
  for (const [name, envName] of Object.entries(requiredSettings)) {
    if (typeof config[name] !== 'string' || !config[name].trim()) throw new Error(`Missing authentication setting: ${envName}. Set ${envName} in .env.`);
  }
  if (Buffer.byteLength(config.sessionSecret) < 32) throw new Error('SESSION_SECRET must contain at least 32 bytes of random secret material.');
  const origin = new URL(config.publicOrigin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== config.publicOrigin || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local && !config.production))) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path (HTTP localhost is allowed only in development).');
  }
  if (config.redirectUri && config.redirectUri !== `${origin.origin}/auth/google/callback`) {
    throw new Error('GOOGLE_REDIRECT_URI must equal PUBLIC_ORIGIN followed by /auth/google/callback.');
  }
  if (config.production && config.store instanceof session.MemoryStore) throw new Error('Production requires a bounded session store.');
  return origin;
}

function authConfigFromEnv(env) {
  const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET'];
  if (!keys.some(key => env[key])) {
    if (env.NODE_ENV === 'production') throw new Error('Google OAuth and SESSION_SECRET must be configured in production.');
    return null;
  }
  const config = {
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET, publicOrigin: env.PUBLIC_ORIGIN,
    redirectUri: env.GOOGLE_REDIRECT_URI || (env.PUBLIC_ORIGIN ? `${env.PUBLIC_ORIGIN}/auth/google/callback` : undefined),
    production: env.NODE_ENV === 'production'
  };
  validateConfig(config);
  return config;
}

function installFacultyAuth(app, { db, auth }) {
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  app.use(['/auth', '/api/auth', '/AdminDashboard.html'], noStore);
  const deny = (req, res) => res.redirect('/?auth=invalid');
  if (!auth) {
    app.get('/auth/google', (req, res) => res.redirect('/?auth=unavailable'));
    app.get('/auth/google/callback', deny);
    app.get('/api/auth/session', (req, res) => res.json({ authenticated: false }));
    app.post('/auth/logout', (req, res) => res.status(401).json({ error: 'Faculty login required.' }));
    return {
      loadFaculty: (req, res, next) => next(),
      requireFaculty: (req, res) => res.status(401).json({ error: 'Faculty login required.' }),
      requirePage: deny,
      requireCsrf: (req, res) => res.status(403).json({ error: 'Invalid request.' })
    };
  }

  const origin = validateConfig(auth);
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Host-capstone.sid' : 'capstone.sid';
  const cookieOptions = { path: '/', httpOnly: true, secure, sameSite: 'lax' };
  const redirectUri = auth.redirectUri || `${origin.origin}/auth/google/callback`;
  const google = auth.googleClient || new OAuth2Client({
    clientId: auth.clientId, clientSecret: auth.clientSecret, redirectUri,
    transporterOptions: { timeout: 10000, retry: false }
  });
  const store = auth.store || createSessionStore();
  app.locals.authStore = store;
  app.use(session({
    name: cookieName, secret: auth.sessionSecret, store,
    resave: false, saveUninitialized: false,
    cookie: { ...cookieOptions, maxAge: LOGIN_TTL }
  }));

  async function forget(req, res) {
    if (req.session) await sessionCall(req, 'destroy');
    res.clearCookie(cookieName, cookieOptions);
  }

  async function loadFaculty(req, res, next) {
    const faculty = req.session?.faculty;
    if (faculty) {
      if (!Number.isFinite(faculty.expiresAt) || faculty.expiresAt <= Date.now()) {
        await forget(req, res);
      } else {
        const [rows] = await db.execute(
          'SELECT AccountID, Email FROM FacultyAccount WHERE LOWER(TRIM(Email)) = ? LIMIT 2', [faculty.email]
        );
        const account = rows[0];
        if (rows.length === 1 && account.AccountID === faculty.accountId &&
            account.Email?.trim().toLowerCase() === faculty.email) {
          req.faculty = account;
        } else {
          await forget(req, res);
        }
      }
    }
    next();
  }

  function requireFaculty(req, res, next) {
    if (!req.faculty) return res.status(401).json({ error: 'Faculty login required.' });
    next();
  }

  function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const requestOrigin = req.get('Origin');
    if ((requestOrigin && requestOrigin !== origin.origin) || req.get('Sec-Fetch-Site') === 'cross-site' ||
        !equalSecret(req.get('X-CSRF-Token'), req.session?.csrfToken)) {
      return res.status(403).json({ error: 'Invalid request.' });
    }
    next();
  }

  const loginLimiter = rateLimit({
    windowMs: LOGIN_TTL, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).send('Too many sign-in attempts. Please try again in 10 minutes.')
  });
  app.use(['/auth/google', '/auth/google/callback'], loginLimiter);

  app.get('/auth/google', async (req, res) => {
    await sessionCall(req, 'regenerate');
    const codeVerifier = randomToken();
    const flow = { state: randomToken(), nonce: randomToken(), codeVerifier, expiresAt: Date.now() + LOGIN_TTL };
    req.session.oauth = flow;
    const url = google.generateAuthUrl({
      scope: ['openid', 'email'], response_type: 'code', access_type: 'online', prompt: 'select_account',
      redirect_uri: redirectUri, state: flow.state, nonce: flow.nonce,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256'
    });
    await sessionCall(req, 'save');
    res.redirect(url);
  });

  app.get('/auth/google/callback', async (req, res) => {
    try {
      const flow = req.session?.oauth;
      if (!flow || !Number.isFinite(flow.expiresAt) || flow.expiresAt <= Date.now() ||
          req.query.error || !equalSecret(req.query.state, flow.state) ||
          typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) {
        throw new Error('Invalid OAuth response');
      }
      // Consume the browser-bound flow before exchanging the one-use code.
      await sessionCall(req, 'regenerate');
      const { tokens } = await google.getToken({ code: req.query.code, codeVerifier: flow.codeVerifier, redirect_uri: redirectUri });
      if (!tokens.id_token) throw new Error('Missing identity token');
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: auth.clientId });
      const identity = ticket.getPayload();
      const email = typeof identity?.email === 'string' ? identity.email.trim().toLowerCase() : '';
      // Google must be authoritative for the email used to join the faculty allowlist.
      if (!identity || identity.email_verified !== true || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.length > 254 || typeof identity.sub !== 'string' || !identity.sub || identity.sub.length > 255 ||
          !equalSecret(identity.nonce, flow.nonce) ||
          (!email.endsWith('@gmail.com') && !(typeof identity.hd === 'string' && identity.hd.length > 0))) {
        throw new Error('Invalid identity');
      }
      const [accounts] = await db.execute(
        'SELECT AccountID, Email FROM FacultyAccount WHERE LOWER(TRIM(Email)) = ? LIMIT 2', [email]
      );
      if (accounts.length !== 1) throw new Error('Faculty not allowed');
      const account = accounts[0];
      // MySQL's collation can equate accents or other distinct characters.
      if (account.Email?.trim().toLowerCase() !== email) throw new Error('Faculty email mismatch');
      req.session.faculty = { accountId: account.AccountID, email, expiresAt: Date.now() + SESSION_TTL };
      req.session.csrfToken = randomToken();
      req.session.cookie.maxAge = SESSION_TTL;
      await sessionCall(req, 'save');
      res.redirect('/');
    } catch {
      // Never log codes, tokens, provider responses, or distinguish faculty emails.
      await forget(req, res);
      res.redirect('/?auth=invalid');
    }
  });

  app.get('/api/auth/session', loadFaculty, (req, res) => {
    res.json(req.faculty ? { authenticated: true, csrfToken: req.session.csrfToken } : { authenticated: false });
  });
  app.post('/auth/logout', loadFaculty, requireFaculty, requireCsrf, async (req, res) => {
    await forget(req, res);
    res.status(204).end();
  });

  return {
    loadFaculty, requireFaculty, requireCsrf,
    requirePage: (req, res, next) => req.faculty ? next() : deny(req, res)
  };
}

module.exports = { installFacultyAuth, authConfigFromEnv, createSessionStore };
