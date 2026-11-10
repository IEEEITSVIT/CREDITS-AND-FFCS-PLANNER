import { WorkerMailer } from 'worker-mailer'

/**
 * VIT Academic Dashboard — API Worker.
 * Static site is served from ./public by the assets binding; this handles /api/*.
 *
 *   POST   /api/register   {email, password, name}
 *   POST   /api/login      {email, password}
 *   POST   /api/logout
 *   POST   /api/forgot     {email}            emails a reset link (always 200)
 *   POST   /api/reset      {token, password}  sets a new password, signs in
 *   GET    /api/me         -> {user, data:{kind: value}}
 *   PUT    /api/data/:kind {data}
 *   DELETE /api/data       clear all stored academic data
 *   DELETE /api/account    {password}  delete account + data
 */

const KINDS = new Set(['grades', 'previous', 'current', 'upcoming', 'timetable', 'timetables', 'curriculum', 'summary', 'profile', 'settings', 'plan', 'debug', 'ffcs', 'ffcsCatalog'])
const SESSION_DAYS = 30
const MAX_DOC_BYTES = 512 * 1024
const PBKDF2_ITER = 100000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILS = 10
const RESET_TTL_MS = 30 * 60 * 1000
const RESET_MAX_PER_HOUR = 3

const enc = new TextEncoder()

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
const err = (message, status = 400) => json({ error: message }, status)

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

function randomB64(n) {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hashPassword(password, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256)
  return b64(bits)
}

const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

function getCookie(request, name) {
  const c = request.headers.get('Cookie') || ''
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

function sessionCookie(token, request, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

async function currentUser(request, env) {
  const token = getCookie(request, 'sid')
  if (!token) return null
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  )
    .bind(await sha256(token), Date.now())
    .first()
  return row || null
}

async function startSession(env, request, userId) {
  const token = randomB64(32)
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, expires),
  ])
  return sessionCookie(token, request, SESSION_DAYS * 86400)
}

const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

async function register(request, env) {
  const body = await readJson(request)
  if (!body) return err('Invalid JSON')
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const name = String(body.name || '').trim().slice(0, 100)
  if (!validEmail(email)) return err('Enter a valid email address')
  if (password.length < 8) return err('Password must be at least 8 characters')
  if (password.length > 200) return err('Password is too long')

  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (exists) return err('An account with this email already exists', 409)

  const saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)))
  const hash = await hashPassword(password, saltB64)
  const res = await env.DB.prepare('INSERT INTO users (email, name, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(email, name, hash, saltB64, Date.now())
    .run()
  const userId = res.meta.last_row_id
  const cookie = await startSession(env, request, userId)
  return json({ user: { id: userId, email, name } }, 201, { 'Set-Cookie': cookie })
}

async function login(request, env) {
  const body = await readJson(request)
  if (!body) return err('Invalid JSON')
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  if (!email || !password) return err('Email and password are required')

  const now = Date.now()
  const att = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE email = ?').bind(email).first()
  if (att && now - att.window_start < LOGIN_WINDOW_MS && att.count >= LOGIN_MAX_FAILS) {
    return err('Too many failed attempts. Try again in 15 minutes.', 429)
  }

  const user = await env.DB.prepare('SELECT id, email, name, password_hash, salt FROM users WHERE email = ?').bind(email).first()
  const ok = user && safeEqual(await hashPassword(password, user.salt), user.password_hash)
  if (!ok) {
    if (!att || now - att.window_start >= LOGIN_WINDOW_MS) {
      await env.DB.prepare('INSERT OR REPLACE INTO login_attempts (email, count, window_start) VALUES (?, 1, ?)').bind(email, now).run()
    } else {
      await env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE email = ?').bind(email).run()
    }
    return err('Incorrect email or password', 401)
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run()
  const cookie = await startSession(env, request, user.id)
  return json({ user: { id: user.id, email: user.email, name: user.name } }, 200, { 'Set-Cookie': cookie })
}

async function logout(request, env) {
  const token = getCookie(request, 'sid')
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request, 0) })
}

async function me(user, env) {
  const { results } = await env.DB.prepare('SELECT kind, data, updated_at FROM academic_data WHERE user_id = ?').bind(user.id).all()
  const data = {}
  const updated = {}
  for (const r of results || []) {
    try {
      data[r.kind] = JSON.parse(r.data)
      updated[r.kind] = r.updated_at
    } catch {}
  }
  return json({ user, data, updated })
}

async function putData(request, env, user, kind) {
  if (!KINDS.has(kind)) return err('Unknown data kind', 404)
  const text = await request.text()
  // The course catalogue (every course's faculty/slot list) is bigger than other documents.
  if (text.length > (kind === 'ffcsCatalog' ? 1800 * 1024 : MAX_DOC_BYTES)) return err('Data too large', 413)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return err('Invalid JSON')
  }
  if (!body || !('data' in body)) return err('Body must be {data: ...}')
  const now = Date.now()
  await env.DB.prepare(
    'INSERT INTO academic_data (user_id, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  )
    .bind(user.id, kind, JSON.stringify(body.data), now)
    .run()
  return json({ ok: true, kind, updated_at: now })
}

async function deleteAccount(request, env, user) {
  const body = await readJson(request)
  const row = await env.DB.prepare('SELECT password_hash, salt FROM users WHERE id = ?').bind(user.id).first()
  if (!body || !row || !safeEqual(await hashPassword(String(body.password || ''), row.salt), row.password_hash)) {
    return err('Incorrect password', 401)
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM academic_data WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ])
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request, 0) })
}

// ---------- password reset ----------
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function sendMail(env, { to, subject, text, html }) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) throw new Error('SMTP is not configured')
  const port = Number(env.SMTP_PORT || 587)
  const mailer = await WorkerMailer.connect({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    startTls: port !== 465,
    credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
    authType: ['plain', 'login'],
    socketTimeoutMs: 10000,
    responseTimeoutMs: 10000,
  })
  try {
    await mailer.send({
      from: { name: 'VIT Academic Dashboard', email: env.MAIL_FROM || env.SMTP_USER },
      to: { email: to },
      subject,
      text,
      html,
    })
  } finally {
    try { await mailer.close() } catch {}
  }
}

function resetEmail(link, name) {
  const hi = name ? `Hi ${escHtml(name)},` : 'Hi,'
  const text = `${name ? `Hi ${name},` : 'Hi,'}\n\nSomeone asked to reset the password for your VIT Academic Dashboard account. Open this link to choose a new password (valid for 30 minutes):\n\n${link}\n\nIf this wasn't you, ignore this email; your password stays the same.`
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f6f7fb;padding:24px;color:#171a23">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e6ef;border-radius:14px;padding:28px">
    <div style="font-weight:700;font-size:17px;margin-bottom:16px">VIT Academic Dashboard</div>
    <p style="margin:0 0 12px">${hi}</p>
    <p style="margin:0 0 20px;color:#444">Someone asked to reset the password for your account. Choose a new password with the button below. The link works for 30 minutes.</p>
    <a href="${escHtml(link)}" style="display:inline-block;background:#3b5bdb;color:#fff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:9px">Reset password</a>
    <p style="margin:20px 0 0;color:#646b7f;font-size:13px">If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${escHtml(link)}</span></p>
    <p style="margin:16px 0 0;color:#646b7f;font-size:13px">If this wasn't you, ignore this email. Your password stays the same.</p>
  </div></div>`
  return { text, html }
}

async function forgot(request, env, ctx) {
  const body = await readJson(request)
  const email = String(body?.email || '').trim().toLowerCase()
  const generic = json({ ok: true, message: 'If an account exists for that email, a reset link is on its way.' })
  if (!validEmail(email)) return generic

  const user = await env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?').bind(email).first()
  if (!user) return generic
  const now = Date.now()
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?').bind(user.id, now - 3600000).first()
  if ((recent?.n || 0) >= RESET_MAX_PER_HOUR) return generic

  const token = randomB64(32)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM password_resets WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), user.id, now, now + RESET_TTL_MS),
  ])
  const base = (env.APP_URL || new URL(request.url).origin).replace(/\/+$/, '')
  const link = `${base}/#/reset/${token}`

  // Send in the background so the response time doesn't reveal whether the account exists.
  const job = (async () => {
    try {
      await sendMail(env, { to: user.email, subject: 'Reset your VIT Academic Dashboard password', ...resetEmail(link, user.name) })
    } catch (e) {
      console.error('[reset] email failed:', e.message)
      if (env.DEV_LOG_RESET_LINKS === 'true') console.log('[reset] dev link for', user.email, link)
    }
  })()
  ctx.waitUntil(job)
  return generic
}

async function resetPassword(request, env) {
  const body = await readJson(request)
  const token = String(body?.token || '')
  const password = String(body?.password || '')
  if (!token) return err('This reset link is invalid.')
  if (password.length < 8) return err('Password must be at least 8 characters')
  if (password.length > 200) return err('Password is too long')

  const row = await env.DB.prepare(
    'SELECT r.user_id, u.email, u.name FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at > ?'
  )
    .bind(await sha256(token), Date.now())
    .first()
  if (!row) return err('This reset link has expired or was already used. Request a new one.', 400)

  const saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)))
  const hash = await hashPassword(password, saltB64)
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').bind(hash, saltB64, row.user_id),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(row.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
    env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(row.email),
  ])
  const cookie = await startSession(env, request, row.user_id)
  return json({ user: { id: row.user_id, email: row.email, name: row.name } }, 200, { 'Set-Cookie': cookie })
}

// ---------- share links (read-only, public) ----------
async function createShare(request, env, user) {
  const text = await request.text()
  if (text.length > 120 * 1024) return err('Timetable too large to share', 413)
  let body
  try { body = JSON.parse(text) } catch { return err('Invalid JSON') }
  if (!body?.data || !Array.isArray(body.data.picks)) return err('Nothing to share')
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM shares WHERE user_id = ?').bind(user.id).first()
  if ((count?.n || 0) >= 50) return err('You have 50 shared links already. Delete some first.', 429)
  const id = randomB64(9)
  await env.DB.prepare('INSERT INTO shares (id, user_id, title, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, user.id, String(body.title || '').slice(0, 80), JSON.stringify(body.data), Date.now()).run()
  return json({ id })
}

async function readShare(env, id) {
  const row = await env.DB.prepare('SELECT title, data, created_at FROM shares WHERE id = ?').bind(id).first()
  if (!row) return err('This link does not exist or was removed', 404)
  return json({ title: row.title, data: JSON.parse(row.data), created_at: row.created_at })
}

// Reject cross-site state-changing requests (defence in depth on top of SameSite=Lax).
function sameOrigin(request) {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  return origin === new URL(request.url).origin
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '')
  const method = request.method

  if (method !== 'GET' && !sameOrigin(request)) return err('Cross-origin request blocked', 403)

  if (path === '/api/register' && method === 'POST') return register(request, env)
  if (path === '/api/login' && method === 'POST') return login(request, env)
  if (path === '/api/logout' && method === 'POST') return logout(request, env)
  if (path === '/api/forgot' && method === 'POST') return forgot(request, env, ctx)
  if (path === '/api/reset' && method === 'POST') return resetPassword(request, env)
  const shareGet = path.match(/^\/api\/share\/([A-Za-z0-9_-]{6,20})$/)
  if (shareGet && method === 'GET') return readShare(env, shareGet[1])

  const user = await currentUser(request, env)
  if (!user) return err('Not signed in', 401)

  if (path === '/api/me' && method === 'GET') return me(user, env)
  const m = path.match(/^\/api\/data\/([A-Za-z]+)$/)
  if (m && method === 'PUT') return putData(request, env, user, m[1])
  if (path === '/api/data' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM academic_data WHERE user_id = ?').bind(user.id).run()
    return json({ ok: true })
  }
  if (path === '/api/account' && method === 'DELETE') return deleteAccount(request, env, user)
  if (path === '/api/share' && method === 'POST') return createShare(request, env, user)
  if (shareGet && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM shares WHERE id = ? AND user_id = ?').bind(shareGet[1], user.id).run()
    return json({ ok: true })
  }

  return err('Not found', 404)
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx)
      } catch (e) {
        console.error(e)
        return err('Server error', 500)
      }
    }
    return env.ASSETS.fetch(request)
  },
}
