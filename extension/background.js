// VIT Academic Dashboard Sync — background service worker.
// When the dashboard asks for a sync, this finds your logged-in VTOP tab and loads the
// Grade History, Curriculum and Time Table pages *inside that tab*, using your own session,
// the same requests VTOP's menu makes when you click it. Raw page HTML goes back to the
// dashboard, which parses it. No passwords are read or stored.

const VTOP = 'https://vtop.vit.ac.in'
const VTOP_HOSTS = ['https://vtop.vit.ac.in/*', 'https://vtopcc.vit.ac.in/*']
// Must match manifest.json content_scripts.matches. Only these sites can request a sync.
const DASHBOARD_ORIGINS = ['http://localhost:8787']

const FALLBACK = {
  grades: 'examinations/examGradeView/StudentGradeHistory',
  timetable: ['academics/common/StudentTimeTable', 'academics/common/StudentTimeTableChn'],
  timetableView: 'processViewTimeTable',
  curriculum: 'academics/common/Curriculum',
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'sync' && msg?.type !== 'alloc') return
  const origin = sender.origin || (sender.url && new URL(sender.url).origin)
  if (!DASHBOARD_ORIGINS.includes(origin)) {
    reply({ ok: false, error: 'This site is not allowed to sync.' })
    return
  }
  const progress = (text) => sender.tab?.id && chrome.tabs.sendMessage(sender.tab.id, { type: 'progress', text }).catch(() => {})
  const job = msg.type === 'alloc' ? allocation(progress, msg.preferTerm || '') : sync(progress)
  job.then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }))
  return true // async reply
})

// ---- functions injected into the VTOP tab (must be self-contained) ----

function pageContext() {
  const csrf =
    document.querySelector('input[name="_csrf"]')?.value ||
    document.querySelector('meta[name="_csrf"]')?.content ||
    (document.documentElement.innerHTML.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1]
  const html = document.documentElement.innerHTML
  const authId =
    document.getElementById('authorizedIDX')?.value ||
    document.querySelector('input[name="authorizedID"]')?.value ||
    (html.match(/authorizedID[^A-Za-z0-9]{1,30}([0-9]{2}[A-Z]{3}[0-9]{4})/) || [])[1] ||
    (document.body?.innerText.match(/\b([0-9]{2}[A-Z]{3}[0-9]{4})\b/) || [])[1]
  const menu = []
  document.querySelectorAll('[data-url]').forEach((a) => menu.push({ text: a.textContent.trim(), url: a.getAttribute('data-url') }))
  for (const m of html.matchAll(/loadmydiv\('([^']+)'\)[^>]*>([^<]{2,60})</g)) menu.push({ text: m[2].trim(), url: m[1] })
  document.querySelectorAll('a, button, [onclick]').forEach((a) => {
    const attr = [a.getAttribute('data-url'), a.getAttribute('href'), a.getAttribute('onclick')].filter(Boolean).join(' ')
    const route = (attr.match(/(academics\/[A-Za-z0-9/_-]+)/) || [])[1]
    if (route) menu.push({ text: a.textContent.trim().slice(0, 80), url: route })
  })
  const loginPage = !!document.querySelector('input[name="captchaStr"], #vtopLoginForm, form[action*="login"] input[type="password"]')
  return { csrf, authId, menu, loginPage, url: location.href }
}

async function vtopPost(path, fields) {
  try {
    const res = await fetch(location.origin + '/vtop/' + path.replace(/^\/+/, ''), {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams(fields),
    })
    const html = await res.text()
    const loginPage = /\/login\b/.test(res.url) || /name="captchaStr"|id="vtopLoginForm"/i.test(html)
    let options = []
    let viewPath = null
    if (/semesterSubId/i.test(html)) {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const sel = doc.querySelector('select#semesterSubId, select[name="semesterSubId"]')
      options = sel ? [...sel.options].map((o) => ({ id: o.value.trim(), name: o.textContent.replace(/\s+/g, ' ').trim() })).filter((o) => o.id) : []
      viewPath = (html.match(/["']\/?(?:vtop\/)?([A-Za-z/]*process[A-Za-z]*Time[Tt]able[A-Za-z]*)["']/) || [])[1] || null
    }
    return { ok: res.ok, status: res.status, html, loginPage, options, viewPath, url: res.url }
  } catch (e) {
    return { ok: false, status: 0, html: '', error: String(e.message || e) }
  }
}

// ---- sync orchestration ----

async function findVtopTab() {
  const tabs = await chrome.tabs.query({ url: VTOP_HOSTS })
  return tabs.find((t) => /\/vtop\/(content|init|main)/.test(t.url || '')) || tabs[0] || null
}

async function run(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return res?.result
}

async function sync(progress) {
  progress('Looking for your VTOP tab…')
  const tab = await findVtopTab()
  if (!tab) {
    await chrome.tabs.create({ url: VTOP + '/vtop/open/page', active: true })
    return { ok: false, needLogin: true, error: 'Opened VTOP in a new tab. Log in there, then click Sync again.' }
  }

  const ctx = await run(tab.id, pageContext)
  if (!ctx || ctx.loginPage || !ctx.csrf || !ctx.authId) {
    await chrome.tabs.update(tab.id, { active: true })
    return { ok: false, needLogin: true, error: 'Log in to VTOP in the tab that just opened, then click Sync again.' }
  }

  const menuUrls = (re) => ctx.menu.filter((m) => re.test(m.text)).map((m) => m.url)
  const menuUrl = (re, fallback) => menuUrls(re)[0] || fallback
  const base = { verifyMenu: 'true', authorizedID: ctx.authId, _csrf: ctx.csrf, nocache: '@' + new Date().toString() }
  const errors = []
  const steps = []
  const out = { ok: true, regNo: ctx.authId, gradeHistory: '', curriculum: '', timetables: [], semestersListed: [], errors, steps, debug: {} }

  // `fields` replaces the default menu fields when given (sub-requests aren't menu clicks).
  const post = async (label, path, extra = {}, fields = null) => {
    const r = await run(tab.id, vtopPost, [path, fields || { ...base, ...extra }])
    if (r && /menu is not available/i.test(r.html || '')) r.notAvailable = true
    steps.push({ label, path, status: r?.status ?? 0, kb: Math.round((r?.html?.length || 0) / 1024), tables: (r?.html?.match(/<table/gi) || []).length, semesters: r?.options?.length || 0 })
    if (r?.loginPage) throw Object.assign(new Error('VTOP session expired. Log in to VTOP again, then click Sync.'), { needLogin: true })
    return r || { ok: false, status: 0, html: '' }
  }
  const fetchPage = async (label, path, extra = {}) => {
    const r = await post(label, path, extra)
    if (!r.ok) { errors.push(`${label}: ${r.error || 'HTTP ' + r.status}`); return '' }
    return r.html
  }

  try {
    progress('Fetching grade history…')
    out.gradeHistory = await fetchPage('Grade history', menuUrl(/grade\s*history/i, FALLBACK.grades))
    await pause(300)

    progress('Fetching curriculum…')
    out.curriculum = await fetchPage('Curriculum', menuUrl(/curriculum/i, FALLBACK.curriculum))
    await pause(300)

    // Time table: try the menu's link first, then known paths, until one lists semesters.
    progress('Fetching timetable semesters…')
    const candidates = [...new Set([...menuUrls(/time\s*table/i), ...FALLBACK.timetable])]
    let ttPage = null
    for (const path of candidates) {
      const r = await post('Time table page', path)
      if (r.ok && r.options?.length) { ttPage = r; break }
      if (r.ok && !out.debug.timetablePage) out.debug.timetablePage = r.html.slice(0, 400000)
      await pause(250)
    }
    if (!ttPage) {
      errors.push(`Time table: no semester list found (tried ${candidates.join(', ')})`)
    } else {
      out.semestersListed = ttPage.options
      const viewPaths = [...new Set([ttPage.viewPath, FALLBACK.timetableView].filter(Boolean))]
      // VTOP's own page sends only these fields for a semester's timetable; adding verifyMenu
      // makes VTOP answer "This menu is not available at present". Try that first, then variants.
      const variants = (semId) => [
        { _csrf: ctx.csrf, semesterSubId: semId, authorizedID: ctx.authId, x: new Date().toUTCString() },
        { _csrf: ctx.csrf, semesterSubId: semId, authorizedID: ctx.authId },
        { ...base, semesterSubId: semId, x: new Date().toUTCString() },
      ]
      let working = null // remember which path/fields worked, reuse for the rest
      for (let i = 0; i < ttPage.options.length; i++) {
        const s = ttPage.options[i]
        progress(`Fetching timetable ${i + 1} of ${ttPage.options.length}: ${s.name}`)
        let html = '', lastNote = ''
        const tries = working ? [working] : viewPaths.flatMap((vp) => variants(s.id).map((_, vi) => ({ vp, vi })))
        for (const t of tries) {
          const r = await post(`Timetable ${s.name}`, t.vp, {}, variants(s.id)[t.vi])
          if (r.ok && !r.notAvailable && /<table/i.test(r.html)) { html = r.html; working = t; break }
          lastNote = r.notAvailable ? 'VTOP said the menu is not available' : r.ok ? 'no tables in the reply' : `HTTP ${r.status}`
          if (r.ok && !out.debug.emptyTimetable) out.debug.emptyTimetable = r.html.slice(0, 200000)
          await pause(200)
        }
        if (html) out.timetables.push({ ...s, html })
        else errors.push(`Timetable ${s.name}: ${lastNote}`)
        await pause(300)
      }
    }
  } catch (e) {
    if (e.needLogin) {
      await chrome.tabs.update(tab.id, { active: true })
      return { ok: false, needLogin: true, error: e.message }
    }
    throw e
  }
  progress('Done')
  return out
}

// ---------------- Course allocation (faculty / slots / venues for FFCS) ----------------
// Same flow VTOP's Course Registration Allocation page uses: open the page, read the semester
// and category lists, list the courses in each category, then each course's slot/faculty table.

async function vtopAlloc(op, route, fields) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const res = await fetch(location.origin + '/vtop/' + route.replace(/^\/+/, ''), {
    method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: new URLSearchParams(fields),
  }).catch((e) => ({ ok: false, status: 0, text: async () => '', url: '', _e: e }))
  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const text = clean(doc.body?.textContent || '')
  const out = { ok: res.ok, status: res.status, bytes: html.length }
  if (/\/login\b/.test(res.url || '') || doc.querySelector('input[name="captchaStr"], input[type="password"]') || /session expired|invalid csrf/i.test(text)) return { ...out, loginPage: true }
  if (/menu is not available/i.test(text)) out.notAvailable = true
  const validOpt = (o) => o.value && !o.disabled && !/^(0|-1|select.*|all)$/i.test(o.value.trim()) && !/^\s*-*\s*select/i.test(o.textContent)

  if (op === 'page') {
    const termSel = doc.querySelector('select#semesterSubId, select[name="semesterSubId"], select#semesterId, select[name="semesterId"]')
    out.termField = termSel ? termSel.getAttribute('name') || termSel.id : null
    out.terms = termSel ? [...termSel.options].filter(validOpt).map((o) => ({ value: o.value.trim(), text: clean(o.textContent), selected: o.hasAttribute('selected') })) : []
    const catSel = doc.querySelector('select#cccategory, select[name="cccategory"]')
    out.categories = catSel ? [...catSel.options].filter(validOpt).map((o) => ({ code: o.value.trim(), label: clean(o.textContent) })) : []
    const scripts = [...doc.querySelectorAll('script')].map((x) => x.textContent).join('\n')
    out.categoryRoute = (scripts.match(/academics\/[A-Za-z0-9/_-]*get[A-Za-z]*(?:Curricul|Categor)[A-Za-z]*/g) || []).find((r) => !/getCoursesListForCurriculmCategory/i.test(r)) || null
    if (!out.terms.length && !out.categories.length) out.snippet = html.slice(0, 20000)
    return out
  }
  if (op === 'categories') {
    out.categories = [...doc.querySelectorAll('option')].filter(validOpt).map((o) => ({ code: o.value.trim(), label: clean(o.textContent) }))
    return out
  }
  if (op === 'courses') {
    out.courses = [...doc.querySelectorAll('option')]
      .filter((o) => !o.disabled && /^[A-Z]{2,8}\d{3,5}[A-Z]?$/i.test(o.value.trim()))
      .map((o) => ({ code: o.value.trim().toUpperCase(), title: clean(o.textContent).replace(/^[A-Z]{2,8}\d{3,5}[A-Z]?\s*[-:]\s*/i, '') }))
    out.empty = !out.courses.length && /no (course|record|data)/i.test(text)
    if (!out.courses.length && !out.empty) out.snippet = html.slice(0, 20000)
    return out
  }
  if (op === 'detail') {
    const SLOT = /^(?:NIL|(?:L\d{1,2}|[A-Z]{1,3}\d{1,2})(?:\+(?:L\d{1,2}|[A-Z]{1,3}\d{1,2}))*)$/
    const sections = [], seen = new Set()
    let credits = null
    for (const table of doc.querySelectorAll('table')) {
      let idx = null
      for (const tr of table.querySelectorAll('tr')) {
        const cells = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map((c) => clean(c.textContent))
        const si = cells.findIndex((c) => /^slot(\s|$)/i.test(c)), fi = cells.findIndex((c) => /faculty/i.test(c)), vi = cells.findIndex((c) => /venue|room/i.test(c))
        if (si >= 0 && fi >= 0) { idx = { s: si, f: fi, v: vi }; continue }
        const ltpjc = cells.find((c) => /^(\d+(\.\d+)?\s+){4}\d+(\.\d+)?$/.test(c))
        if (ltpjc && credits === null) credits = Number(ltpjc.split(/\s+/).pop())
        const use = idx || (cells.length === 4 ? { s: 0, v: 1, f: 2 } : null)
        if (!use) continue
        const slot = (cells[use.s] || '').toUpperCase().replace(/\s+/g, '')
        const faculty = clean(cells[use.f]), venue = use.v >= 0 ? clean(cells[use.v]) : ''
        if (!SLOT.test(slot) || !faculty) continue
        const key = slot + '|' + faculty + '|' + venue
        if (!seen.has(key)) { seen.add(key); sections.push({ slot, faculty, venue }) }
      }
    }
    out.sections = sections
    out.credits = credits
    out.empty = !sections.length && /no (course|record|data)|not (offered|available)/i.test(text)
    if (!sections.length && !out.empty) out.snippet = html.slice(0, 20000)
    return out
  }
  return out
}

async function allocation(progress, preferTerm) {
  progress('Looking for your VTOP tab…')
  const tab = await findVtopTab()
  if (!tab) {
    await chrome.tabs.create({ url: VTOP + '/vtop/open/page', active: true })
    return { ok: false, needLogin: true, error: 'Opened VTOP in a new tab. Log in there, then click Fetch again.' }
  }
  const ctx = await run(tab.id, pageContext)
  if (!ctx || ctx.loginPage || !ctx.csrf || !ctx.authId) {
    await chrome.tabs.update(tab.id, { active: true })
    return { ok: false, needLogin: true, error: 'Log in to VTOP in the tab that just opened, then click Fetch again.' }
  }
  const steps = [], errors = [], debug = {}
  const base = () => ({ _csrf: ctx.csrf, authorizedID: ctx.authId, x: new Date().toUTCString() })
  const call = async (label, op, route, fields) => {
    const r = await run(tab.id, vtopAlloc, [op, route, fields])
    steps.push({ label, path: route, status: r?.status ?? 0, kb: Math.round((r?.bytes || 0) / 1024) })
    if (r?.loginPage) throw Object.assign(new Error('VTOP session expired. Log in to VTOP again, then click Fetch.'), { needLogin: true })
    await pause(150)
    return r || {}
  }
  try {
    const re = /course\s*(?:registration\s*)?allocation|course\s*offering/i
    const routes = [...new Set([
      ...ctx.menu.filter((m) => re.test(m.text) || /course\w*allocation|registration\w*allocation/i.test(m.url)).map((m) => m.url),
      'academics/common/StudentCourseAllocation', 'academics/common/CourseRegistrationAllocation',
    ])].filter((r) => /^academics\//i.test(r))
    let page = null
    for (const route of routes) {
      progress('Opening Course Registration Allocation…')
      let r = await call('Allocation page', 'page', route, base())
      if (r.notAvailable || (!r.terms?.length && !r.categories?.length)) r = await call('Allocation page (menu)', 'page', route, { ...base(), verifyMenu: 'true' })
      if (r.terms?.length || r.categories?.length) { page = { ...r, route }; break }
      if (r.snippet && !debug.page) debug.page = r.snippet
    }
    if (!page) return { ok: false, error: `Couldn't open the Course Registration Allocation page (tried ${routes.join(', ')}).`, steps, debug }

    const want = String(preferTerm || '').toLowerCase()
    const term = page.terms.find((t) => want && t.text.toLowerCase().includes(want)) || page.terms.find((t) => t.selected) || page.terms.find((t) => /current/i.test(t.text)) || page.terms[0] || null
    const termFields = term && page.termField ? { [page.termField]: term.value } : {}
    let categories = page.categories
    if (!categories.length && page.categoryRoute) {
      const r = await call('Categories', 'categories', page.categoryRoute, { ...base(), ...termFields })
      categories = r.categories || []
    }
    if (!categories.length) return { ok: false, error: 'No course categories found on the allocation page.', steps, debug: { page: page.snippet } }

    const courses = new Map()
    for (let i = 0; i < categories.length; i++) {
      const c = categories[i]
      progress(`Listing courses: ${c.label} (${i + 1}/${categories.length})`)
      const r = await call(`Courses ${c.code}`, 'courses', 'academics/common/getCoursesListForCurriculmCategory', { ...base(), ...termFields, cccategory: c.code })
      if (r.snippet && !debug.courses) debug.courses = r.snippet
      for (const course of r.courses || []) if (!courses.has(course.code)) courses.set(course.code, { ...course, category: c.code, categoryLabel: c.label })
    }
    const list = [...courses.values()]
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      progress(`Faculty & slots ${i + 1}/${list.length}: ${c.code}`)
      const r = await call(`Detail ${c.code}`, 'detail', 'academics/common/getCoursesDetailForRegistration', { ...base(), ...termFields, courseCode: c.code })
      c.sections = r.sections || []
      c.credits = r.credits ?? null
      if (r.snippet && !debug.detail) debug.detail = r.snippet
      if (!r.ok) errors.push(`${c.code}: HTTP ${r.status}`)
    }
    progress('Done')
    return { ok: true, term: term ? { value: term.value, text: term.text } : null, categories, courses: list, errors, steps: steps.slice(0, 40), debug }
  } catch (e) {
    if (e.needLogin) { await chrome.tabs.update(tab.id, { active: true }); return { ok: false, needLogin: true, error: e.message } }
    throw e
  }
}
