'use strict';

// Was an inline <script> in login.html; moved to a file so the Content-Security-Policy
// can use script-src 'self' with no 'unsafe-inline'.
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const errorEl = document.getElementById('loginError');
const noticeEl = document.getElementById('loginNotice');

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function show(form) {
  loginForm.hidden = form !== loginForm;
  signupForm.hidden = form !== signupForm;
}

// Only offer sign-up when the server allows it (SIGNUP_MODE).
fetch('/api/session').then((r) => r.json()).then((s) => {
  if (s.authenticated) { window.location.href = '/'; return; }
  if (s.signupMode && s.signupMode !== 'off') {
    document.getElementById('showSignupBtn').hidden = false;
    document.getElementById('signupModeText').textContent = s.signupMode === 'approval'
      ? 'An admin has to approve new accounts before they can sign in.'
      : 'Your account works straight away.';
  }
}).catch(() => {});

document.getElementById('showSignupBtn').addEventListener('click', () => show(signupForm));
document.getElementById('showLoginBtn').addEventListener('click', () => show(loginForm));

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const { ok, data } = await postJson('/api/login', { username, password });
  if (ok) {
    window.location.href = '/';
  } else {
    errorEl.textContent = data.error || 'Sign in failed';
    errorEl.hidden = false;
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('signupError');
  err.hidden = true;
  const username = document.getElementById('signupUsername').value.trim();
  const password = document.getElementById('signupPassword').value;
  if (password !== document.getElementById('signupPassword2').value) {
    err.textContent = 'The two passwords are different';
    err.hidden = false;
    return;
  }
  const { ok, data } = await postJson('/api/signup', { username, password });
  if (!ok) {
    err.textContent = data.error || 'Sign-up failed';
    err.hidden = false;
    return;
  }
  signupForm.reset();
  show(loginForm);
  document.getElementById('username').value = username;
  noticeEl.textContent = data.status === 'pending'
    ? 'Account created. An admin has to approve it before you can sign in.'
    : 'Account created. Sign in below.';
  noticeEl.hidden = false;
});
