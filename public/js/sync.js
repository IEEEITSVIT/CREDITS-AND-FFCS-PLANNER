// One-click VTOP sync through the "VIT Academic Dashboard Sync" browser extension.
// The extension loads VTOP pages inside your logged-in VTOP tab and hands back raw HTML;
// everything is parsed here with the same parser used for paste/upload.
import { parseVtopHtml } from './vtop-parser.js'
import { effectiveCourses, isGraded } from './calc.js'
import { sortSemesters, currentAndUpcoming } from './semesters.js'

export const ext = { version: null }
const listeners = new Set()
export const onExtChange = (fn) => listeners.add(fn)

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data) return
  if (e.data.type === 'vitdash-ext-ready' && !ext.version) {
    ext.version = e.data.version || '1'
    listeners.forEach((fn) => fn())
  }
})
window.postMessage({ type: 'vitdash-ext-ping' }, location.origin)

export function requestSync(onProgress) {
  return new Promise((resolve) => {
    const handler = (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data) return
      if (e.data.type === 'vitdash-sync-progress') onProgress?.(e.data.text)
      if (e.data.type === 'vitdash-sync-result') {
        window.removeEventListener('message', handler)
        resolve(e.data.result || { ok: false, error: 'No response from the extension' })
      }
    }
    window.addEventListener('message', handler)
    window.postMessage({ type: 'vitdash-sync-request' }, location.origin)
  })
}

// Course allocation (faculty / slots) for the Timetable Builder.
export function requestAllocation(preferTerm, onProgress) {
  return new Promise((resolve) => {
    const handler = (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data) return
      if (e.data.type === 'vitdash-sync-progress') onProgress?.(e.data.text)
      if (e.data.type === 'vitdash-alloc-result') {
        window.removeEventListener('message', handler)
        resolve(e.data.result || { ok: false, error: 'No response from the extension' })
      }
    }
    window.addEventListener('message', handler)
    window.postMessage({ type: 'vitdash-alloc-request', preferTerm }, location.origin)
  })
}

const gradeKey = (g) => `${g.code}|${String(g.examMonth || '').toLowerCase()}`

// A semester is "done" when most of its courses already have a grade in grade history.
function isCompleted(sem, gradedCodes) {
  const codes = sem.courses.map((c) => c.code)
  if (!codes.length) return true
  return codes.filter((c) => gradedCodes.has(c)).length / codes.length >= 0.6
}

// VTOP lists semesters newest first. Current = newest unfinished one that has an even newer
// unfinished one (= upcoming) above it, else the newest unfinished one.
export function pickSemesters(timetables, grades) {
  const graded = new Set(effectiveCourses(grades).filter((g) => isGraded(g.grade) || g.grade === 'P').map((g) => g.code))
  const open = timetables.filter((s) => !isCompleted(s, graded))
  if (open.length >= 2) return { currentSemId: open[1].id, upcomingSemId: open[0].id }
  if (open.length === 1) return { currentSemId: open[0].id, upcomingSemId: null }
  return { currentSemId: timetables[0]?.id || null, upcomingSemId: null }
}

// VTOP courses keep the expected grades already chosen; courses typed in by hand are kept too.
const keepExpected = (courses, previous) => {
  // Expected grades by course code, from synced rows and from hand-typed rows that named a code.
  const prev = {}
  for (const c of previous || []) if (c.code && (!prev[c.code] || (!prev[c.code].expected && c.expected))) prev[c.code] = c
  const synced = courses.map((c) => ({ ...c, manual: false, expected: prev[c.code]?.expected || '', ng: prev[c.code]?.ng ?? c.ng }))
  const codes = new Set(synced.map((c) => c.code))
  const manual = (previous || []).filter((c) => c.manual && (c.title || Number(c.credits) > 0) && !(c.code && codes.has(c.code)))
  return [...synced, ...manual]
}

// Turn the extension's raw HTML into saved data. Returns a summary for the UI.
export async function applySync(result, data, save) {
  const gh = result.gradeHistory ? parseVtopHtml(result.gradeHistory) : {}
  const cur = result.curriculum ? parseVtopHtml(result.curriculum) : {}
  const parsedTts = (result.timetables || []).map((t) => {
    const p = parseVtopHtml(t.html)
    return { id: t.id, name: t.name, courses: p.current || [], entries: p.timetable?.entries || [], bytes: t.html.length, tables: (t.html.match(/<table/gi) || []).length }
  })
  // Fall (Jun-Nov) / Winter (Dec-May) order, newest first.
  const timetables = sortSemesters(parsedTts.filter((t) => t.courses.length || t.entries.length)).map(({ bytes, tables, ...t }) => t)

  const summary = {
    grades: 0, newGrades: 0, semesters: timetables.length, curriculum: false, errors: [...(result.errors || [])],
    report: {
      semestersListed: (result.semestersListed || result.timetables || []).length,
      timetablePages: parsedTts.map((t) => ({ name: t.name, kb: Math.round(t.bytes / 1024), tables: t.tables, courses: t.courses.length, classes: t.entries.length })),
      steps: result.steps || [],
    },
  }
  if ((result.timetables || []).length && !timetables.length) summary.errors.push('Timetable pages loaded but no courses could be read from them')
  // Local development only: keep a copy of unreadable timetable pages so the reader can be fixed.
  if (((result.timetables || []).length || (result.semestersListed || []).length) && !timetables.length && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    await save('debug', {
      when: new Date().toISOString(),
      steps: result.steps || [],
      semesters: result.semestersListed || [],
      timetablePage: (result.debug?.timetablePage || '').slice(0, 60000),
      emptyTimetable: (result.debug?.emptyTimetable || '').slice(0, 150000),
      pages: result.timetables.slice(0, 3).map((t) => ({ name: t.name, html: t.html.slice(0, 120000) })),
    })
  }

  if (gh.grades?.length) {
    const merged = new Map((data.grades || []).map((g) => [gradeKey(g), g]))
    summary.newGrades = gh.grades.filter((g) => !merged.has(gradeKey(g))).length
    for (const g of gh.grades) merged.set(gradeKey(g), { ...merged.get(gradeKey(g)), ...g })
    await save('grades', [...merged.values()])
    summary.grades = gh.grades.length
  }
  if (gh.summary) await save('summary', gh.summary)
  const curriculum = cur.curriculum || gh.curriculum
  if (curriculum) { await save('curriculum', curriculum); summary.curriculum = true }
  await save('profile', { ...(data.profile || {}), ...(gh.profile || {}), regNo: result.regNo || gh.profile?.regNo || data.profile?.regNo || '' })

  if (timetables.length) {
    // Calendar rule: Jun-Nov -> current Fall, upcoming Winter; Dec-May -> current Winter, upcoming Fall.
    const picked = currentAndUpcoming(timetables)
    // Keep a semester choice made by hand on the Timetable page, if that semester still exists.
    const settings = data.settings || {}
    const ids = new Set(timetables.map((t) => t.id))
    const keep = (k) => (settings.manualSems && (settings[k] === null || ids.has(settings[k])) ? settings[k] : picked[k])
    const sem = { previousSemId: keep('previousSemId'), currentSemId: keep('currentSemId'), upcomingSemId: keep('upcomingSemId') }
    await save('timetables', timetables)
    await save('settings', { ...settings, ...sem })
    await applySemesterChoice(data, save)
    const nameOf = (id) => timetables.find((t) => t.id === id)?.name
    summary.previous = nameOf(sem.previousSemId)
    summary.current = nameOf(sem.currentSemId)
    summary.upcoming = nameOf(sem.upcomingSemId)
  }
  return summary
}

// Latest actual grade per course code from grade history (for the previous semester's list).
function actualGrades(grades) {
  return Object.fromEntries(effectiveCourses(grades || []).map((g) => [g.code, g.grade]))
}

// Copy the chosen previous/current/upcoming semesters' courses into the calculator lists.
// A semester VTOP didn't list leaves that list as it is (your typed-in courses stay).
export async function applySemesterChoice(data, save) {
  const tts = data.timetables || []
  const st = data.settings || {}
  const find = (id) => tts.find((t) => t.id === id)
  const prev = find(st.previousSemId), cur = find(st.currentSemId), up = find(st.upcomingSemId)
  if (prev) {
    const actual = actualGrades(data.grades)
    const list = keepExpected(prev.courses, data.previous).map((c) => {
      const g = actual[c.code]
      // Results already out: use the real grade (marked so the calculator can show it).
      return g && !c.manual ? { ...c, expected: c.expected || (g === 'P' ? 'P' : g), result: g } : c
    })
    await save('previous', list)
  }
  if (cur) {
    await save('current', keepExpected(cur.courses, data.current))
    await save('timetable', { entries: cur.entries, semester: cur.name })
  }
  if (up) await save('upcoming', keepExpected(up.courses, data.upcoming))
}
