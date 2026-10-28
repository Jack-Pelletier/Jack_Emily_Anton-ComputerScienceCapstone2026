(() => {
  'use strict';

  const login = document.querySelector('[data-login]');
  const logout = document.querySelector('[data-logout]');
  const adminLink = document.querySelector('[data-admin-link]');
  const adminPage = document.querySelector('[data-admin-page]');
  if (!login || !logout || !adminLink) return;

  let csrfToken = '';
  let requestVersion = 0;
  let loggingOut = false;

  function showSession(session) {
    const authenticated = session.authenticated === true && typeof session.csrfToken === 'string' && session.csrfToken.length > 0;
    csrfToken = authenticated ? session.csrfToken : '';
    login.hidden = authenticated;
    logout.hidden = !authenticated;
    adminLink.hidden = !authenticated;
    return authenticated;
  }

  async function refreshSession() {
    if (loggingOut) return;
    const version = ++requestVersion;
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('Session could not be checked.');
      const session = await response.json();
      if (version !== requestVersion) return;
      const authenticated = showSession(session);
      if (!authenticated && adminPage) window.location.replace('/');
    } catch {
      // A failed check never grants access or retains a stale dashboard link.
      if (version === requestVersion) showSession({ authenticated: false });
    }
  }

  logout.addEventListener('click', async () => {
    if (loggingOut || !csrfToken) return;
    loggingOut = true;
    ++requestVersion;
    logout.disabled = true;
    logout.textContent = 'Logging out…';
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken }
      });
      if (!response.ok && response.status !== 401) throw new Error('Logout failed.');
      showSession({ authenticated: false });
      window.location.replace('/');
    } catch {
      window.alert('Unable to log out. Please try again.');
    } finally {
      loggingOut = false;
      logout.disabled = false;
      logout.textContent = 'Log out';
      refreshSession();
    }
  });

  const url = new URL(window.location.href);
  const authMessages = {
    invalid: 'invalid credentials',
    unavailable: 'Google login is not configured yet. Please contact the site administrator.'
  };
  const authResult = url.searchParams.get('auth');
  if ((url.pathname === '/' || url.pathname.toLowerCase() === '/home.html') && Object.hasOwn(authMessages, authResult)) {
    url.searchParams.delete('auth');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    window.alert(authMessages[authResult]);
  }

  // Recheck with the server when returning from history or another browser tab.
  window.addEventListener('pageshow', event => {
    if (event.persisted) refreshSession();
  });
  window.addEventListener('pagehide', () => {
    ++requestVersion;
    showSession({ authenticated: false });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshSession();
  });

  refreshSession();
})();
