import { parseVtopHtml, tsvToHtml, toMinutes } from './vtop-parser.js'
import {
  academicStats, project, requiredForTarget, gradePlan, effectiveCourses, isFail, isGraded, isNonGraded, earnsCredit,
  LETTERS, GRADE_POINTS, fmt, semesterLabel, gpaOf,
} from './calc.js'
import { sortSemesters, nextSemesterLabels, calendarSemesters, parseSemesterName } from './semesters.js'
import { viewBuilder, builderClick, builderInput, builderChange, builderSubmit, viewShared } from './builder.js'
import { viewPlanner, plannerResultsHtml, ensureSemRows, rowsCgpa, expectedCardHtml, refreshExpectedNumbers } from './planner.js'
import { ext, onExtChange, requestSync, applySync, applySemesterChoice } from './sync.js'
import { viewCredits, refreshCredits } from './creditplan.js'

// "Fall 2026-27" -> "Fall Semester 2026-27" (VTOP's naming, so sorting/matching works)
const vtopName = (label) => label.replace(/^(Fall|Winter) /, '$1 Semester ')
// Which calculator semester a detected VTOP semester is (previous/current/upcoming), if any.
function roleOf(semName) {
  const p = parseSemesterName(semName)
  const cal = calendarSemesters()
  return ['previous', 'current', 'upcoming'].find((k) => cal[k].term === p.term && cal[k].startYear === p.startYear) || null
}

// ---------- state & helpers ----------
const state = { user: null, data: {}, updated: {}, pendingImport: null, preview: null, day: null, sync: { running: false, progress: '', result: null } }
const CALC_SEMS = ['previous', 'current', 'upcoming']
const ck = () => (CALC_SEMS.includes(state.calcSem) ? state.calcSem : 'current')
const app = document.getElementById('app')

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const DAY_NAMES = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' }
const todayCode = () => ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date().getDay()]

function toast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => t.classList.remove('show'), 2600)
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  let json = {}
  try { json = await res.json() } catch {}
  if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { status: res.status })
  return json
}

async function save(kind, value) {
  state.data[kind] = value
  try {
    const r = await api('PUT', `/api/data/${kind}`, { data: value })
    state.updated[kind] = r.updated_at
  } catch (e) {
    toast(e.status === 401 ? 'Session expired — sign in again' : `Couldn't save: ${e.message}`)
    if (e.status === 401) { state.user = null; render() }
  }
}
const saveSoon = (() => {
  const timers = {}
  return (kind) => {
    clearTimeout(timers[kind])
    timers[kind] = setTimeout(() => save(kind, state.data[kind]), 600)
  }
})()

const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview')
const timeAgo = (ts) => {
  if (!ts) return 'never'
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ts).toLocaleDateString()
}

function runImport() {
  const p = state.pendingImport
  if (!p) return
  state.pendingImport = null
  let parsed = {}
  try { parsed = parseVtopHtml(p.html) } catch (e) { console.error(e) }
  state.preview = { parsed, source: p.source, html: p.html }
}

// ---------- shell ----------
const NAV = [
  ['overview', 'Overview'], ['calculator', 'GPA Calculator'], ['planner', 'CGPA Planner'], ['credits', 'Credit Planner'], ['grades', 'Grade History'],
  ['timetable', 'Timetable'], ['builder', 'Timetable Builder'], ['curriculum', 'Curriculum'], ['import', 'Sync VTOP'],
]

function shell(content) {
  const r = route()
  return `
  <header class="topbar"><div class="topbar-inner">
    <a class="brand" href="#/overview"><span class="brand-mark"><svg width="16" height="16" viewBox="0 0 32 32"><path d="M5 23l6-14 5 10 4-7 7 11" stroke="white" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>VIT Academics</span></a>
    <nav class="tabs">${NAV.map(([k, l]) => `<a href="#/${k}" class="${r === k ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div class="user-menu">${syncButton('sm')}<a href="#/account" class="btn ghost sm ${r === 'account' ? 'active' : ''}" title="${esc(state.user.email)}">${esc(state.user.name || state.user.email.split('@')[0])}</a></div>
  </div></header>
  <main>${content}</main>`
}

function syncButton(size = '') {
  if (!ext.version) return ''
  return `<button class="primary ${size}" data-action="sync" ${state.sync.running ? 'disabled' : ''}>${state.sync.running ? 'Syncing…' : 'Sync from VTOP'}</button>`
}

function noData(what = 'your academic data') {
  return `<div class="card empty"><h2>No data yet</h2><p>Sync ${what} from VTOP, or add courses by hand.</p>
    <a class="btn primary" href="#/import">Sync from VTOP</a></div>`
}

// ---------- views ----------
function viewOverview() {
  const d = state.data
  const s = academicStats(d)
  const has = (d.grades || []).length || (d.current || []).length
  const cg = s.officialCgpa ?? s.cgpa
  const today = (d.timetable?.entries || []).filter((e) => e.day === todayCode())
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()

  const tiles = `
  <div class="grid cols-4">
    <div class="card stat hero"><div class="label">Current CGPA</div><div class="value">${fmt(cg)}</div>
      <div class="sub">${s.officialCgpa != null ? `VTOP official · computed ${fmt(s.cgpa)}` : `${s.gpaCredits} graded credits`}</div></div>
    <div class="card stat"><div class="label">Credits completed</div><div class="value">${fmt(s.earned, s.earned % 1 ? 1 : 0)}</div><div class="sub">of ${s.totalRequired} required${s.ngEarned ? ` · ${fmt(s.ngEarned, s.ngEarned % 1 ? 1 : 0)} non-graded` : ''}</div></div>
    <div class="card stat"><div class="label">Credits pending</div><div class="value">${fmt(s.pending, s.pending % 1 ? 1 : 0)}</div><div class="sub">${fmt(s.pendingAfterCurrent, s.pendingAfterCurrent % 1 ? 1 : 0)} after this semester</div></div>
    <div class="card stat"><div class="label">This semester</div><div class="value">${fmt(s.currentCredits, s.currentCredits % 1 ? 1 : 0)}</div><div class="sub">${(d.current || []).length} courses registered</div></div>
  </div>`

  const failed = s.failed.length
    ? `<div class="notice bad" style="margin-top:16px"><strong>${s.failed.length} course${s.failed.length > 1 ? 's' : ''} to clear:</strong> ${s.failed.map((c) => `${esc(c.code)} ${esc(c.title)} (${c.credits} cr)`).join(', ')}. These count as 0 points in your CGPA until you pass them.</div>`
    : ''

  const cats = d.curriculum?.categories || []
  const progress = `
  <div class="card">
    <div class="card-head"><div><h2>Curriculum completion</h2><div class="muted small">Credits earned / required</div></div><a href="#/curriculum" class="small">Details</a></div>
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><strong>${fmt(s.earned, s.earned % 1 ? 1 : 0)} / ${s.totalRequired}</strong><span class="muted small">${Math.round(s.progress * 100)}%</span></div>
    <div class="progress"><span style="width:${s.progress * 100}%"></span></div>
    ${cats.length ? `<div style="margin-top:14px">${cats.slice(0, 6).map(catRow).join('')}</div>` : `<p class="muted small" style="margin:12px 0 0">Import the curriculum section of Grade History to see category-wise credits.</p>`}
  </div>`

  const todayCard = `
  <div class="card">
    <div class="card-head"><h2>Today · ${DAY_NAMES[todayCode()]}</h2><a href="#/timetable" class="small">Timetable</a></div>
    ${today.length ? `<div class="class-list">${today.map((e) => {
      const st = toMinutes(e.start), en = toMinutes(e.end)
      const now = st <= nowMin && nowMin < en
      return `<div class="class-item ${now ? 'now' : ''}" style="grid-template-columns:80px minmax(0,1fr)"><div class="time">${esc(e.start)}</div><div><strong>${esc(e.code)}</strong> <span class="muted small">${esc(e.title || '')}</span><div class="muted small">${esc(e.kind)} · ${esc(e.venue)}${now ? ' · <strong>now</strong>' : ''}</div></div></div>`
    }).join('')}</div>` : `<p class="muted" style="margin:0">${d.timetable ? 'No classes today.' : 'Import your timetable to see today\'s classes.'}</p>`}
  </div>`

  const trend = s.bySemester.filter((x) => x.sgpa != null)
  const trendCard = trend.length ? `
  <div class="card">
    <div class="card-head"><h2>Semester-wise SGPA</h2><span class="muted small">CGPA after each semester in brackets</span></div>
    <div class="bars">${trend.map((x) => {
      const h = Math.max(((x.sgpa - 4) / 6) * 100, 4)
      return `<div class="bar" title="${esc(x.label)}: SGPA ${fmt(x.sgpa)}, CGPA ${fmt(x.cgpa)}"><div class="col" style="height:${h}%"><span>${fmt(x.sgpa)}</span></div><div class="x">${esc(x.label)}</div><div class="x">(${fmt(x.cgpa)})</div></div>`
    }).join('')}</div>
  </div>` : ''

  return `
  <div class="page-head"><div><h1>Academic overview</h1><p class="muted">${esc(d.profile?.regNo || '')}${d.profile?.regNo ? ' · ' : ''}Last import ${timeAgo(Math.max(0, ...Object.values(state.updated)))}</p></div>
    <div class="row"><a class="btn" href="#/calculator">Expected GPA</a>${syncButton()}</div></div>
  ${has ? '' : `<div class="notice" style="margin-bottom:16px">Nothing synced yet. <a href="#/import">Sync from VTOP</a> to fill this dashboard in.</div>`}
  ${tiles}${failed}
  <div class="grid cols-3-1" style="margin-top:16px">
    <div class="stack">${progress}${trendCard}</div>
    <div class="stack">${todayCard}</div>
  </div>`
}

function catRow(c) {
  const pct = c.required ? Math.min(c.earned / c.required, 1) : 1
  return `<div class="cat-row"><span class="small">${esc(c.name)}</span><span class="small mono">${c.earned} / ${c.required}</span>
    <div class="progress sm ${pct >= 1 ? 'good' : ''}"><span style="width:${pct * 100}%"></span></div></div>`
}

// Earlier semesters' expected grades, treated as results, so later semesters build on them:
// current builds on previous; upcoming builds on previous + current.
function gradesWithExpected(d, kinds) {
  const extra = []
  kinds.forEach((k, n) => {
    ;(d[k] || []).forEach((c, i) => {
      if (!(Number(c.credits) > 0) || !(isGraded(c.expected) || isNonGraded({ ...c, grade: c.expected }))) return
      extra.push({ code: c.code || `__${k}${i}`, title: c.title, credits: Number(c.credits) || 0, grade: c.expected || 'P', examMonth: `Dec-${2997 + n}`, ng: c.ng, category: c.category })
    })
  })
  return [...(d.grades || []), ...extra]
}

const blankCourse = () => ({ manual: true, code: '', title: '', credits: '', ng: false, expected: '' })
const COURSE_CODE_RE = /\b([A-Z]{3,4}\d{3,4}[A-Z]?)\b/i
const ngRow = (c) => isNonGraded({ ...c, grade: c.expected })
const hasRows = (list) => Array.isArray(list) && list.some((c) => c.title || c.code || Number(c.credits) > 0)

// Previous semester straight from grade history (works without the extension).
function previousFromHistory(d) {
  const label = calendarSemesters().previous.label
  const byCode = new Map()
  for (const g of d.grades || []) if (semesterLabel(g.examMonth) === label) byCode.set(g.code, g)
  return [...byCode.values()].map((g) => ({ code: g.code, title: g.title, credits: g.credits, expected: String(g.grade || '').toUpperCase(), result: String(g.grade || '').toUpperCase(), ng: isNonGraded(g), manual: false }))
}

function calcContext() {
  const d = state.data
  const mode = ck()
  if (!hasRows(d[mode])) {
    const fromHistory = mode === 'previous' ? previousFromHistory(d) : []
    d[mode] = fromHistory.length ? fromHistory : [blankCourse()] // saved once edited
  }
  const before = { previous: [], current: ['previous'], upcoming: ['previous', 'current'] }[mode]
  const grades = gradesWithExpected(d, before)
  const list = d[mode]
  const base = before.length ? project(grades, []).cgpa : academicStats(d).cgpa
  return { d, mode, upcomingMode: mode === 'upcoming', grades, list, base }
}

function calcResultsHtml() {
  const { mode, grades, list, base } = calcContext()
  const p = project(grades, list)
  const delta = p.cgpa != null && base != null ? p.cgpa - base : null
  return `
    <div class="muted small">Expected SGPA</div>
    <div class="result-big">${fmt(p.sgpa)}</div>
    <div class="muted small">${p.semCredits} graded credits${p.ungraded ? ` · ${p.ungraded} course${p.ungraded > 1 ? 's' : ''} without a grade` : ''}</div>
    <hr style="border:0;border-top:1px solid var(--border);margin:16px 0">
    <div class="muted small">Projected CGPA</div>
    <div class="result-big">${fmt(p.cgpa)}</div>
    <div class="small">${delta != null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}</span> <span class="muted">from ${fmt(base)}${mode === 'upcoming' ? ' (after previous and current)' : mode === 'current' ? ' (after previous)' : ''}</span>` : `<span class="muted">${grades.length ? '' : 'No grade history yet, so this equals the semester GPA.'}</span>`}</div>`
}

function calcTargetHtml() {
  const { grades, list } = calcContext()
  const tgt = state.target ?? ''
  if (tgt === '') return ''
  const r = requiredForTarget(grades, list, Number(tgt))
  if (r.status === 'nocourses') return `<div class="notice warn">Add courses with credits first.</div>`
  if (r.status === 'impossible') return `<div class="notice bad">Not reachable this semester. Even S in every course gives ${fmt(r.maxCgpa)}.</div>`
  if (r.status === 'easy') return `<div class="notice good">Passing every course (E or better) keeps you at or above ${fmt(Number(tgt))}.</div>`
  const plan = gradePlan(grades, list, Number(tgt))
  const lower = Object.keys(GRADE_POINTS).find((k) => GRADE_POINTS[k] === Math.floor(r.need))
  return `<div class="notice">You need an average of <strong>${fmt(r.need)}</strong> grade points across the graded credits${Math.floor(r.need) === r.need || r.letter === 'E' ? ` (${r.letter} or better in everything)` : ` (between ${lower} and ${r.letter})`}.
    ${plan ? `<div style="margin-top:8px" class="small">One way to get there: ${list.map((c, i) => (plan[i] ? `${esc(c.code || c.title || 'Course ' + (i + 1))} <b>${plan[i]}</b>` : '')).filter(Boolean).join(' · ')}</div>
    <button class="sm" style="margin-top:10px" data-action="apply-plan">Apply these grades</button>` : ''}</div>`
}

function refreshCalc() {
  const r = document.getElementById('calc-results')
  if (r) r.innerHTML = calcResultsHtml()
  const t = document.getElementById('calc-target')
  if (t) t.innerHTML = calcTargetHtml()
}

function viewCalculator() {
  const { d, mode, list } = calcContext()
  const cal = calendarSemesters()
  const tts = d.timetables || []
  const semName = (id) => tts.find((t) => t.id === id)?.name || ''
  const names = {
    previous: semName(d.settings?.previousSemId) || cal.previous.label,
    current: semName(d.settings?.currentSemId) || cal.current.label,
    upcoming: semName(d.settings?.upcomingSemId) || cal.upcoming.label,
  }
  const repeatCodes = new Set(effectiveCourses(d.grades || []).map((c) => c.code))
  const titles = { previous: 'Previous semester', current: 'Current semester', upcoming: 'Upcoming semester' }
  const fromHistory = mode === 'previous' && list.some((c) => c.result)
  const notes = {
    previous: fromHistory ? 'Filled from your grade history. Change any grade to see "what if".' : 'Results not in your grade history yet. Enter what you expect, or import Grade History from VTOP.',
    current: `Projected CGPA assumes the grades on the Previous tab (${esc(names.previous)}).`,
    upcoming: `Projected CGPA assumes the grades on the Previous and Current tabs.`,
  }

  const row = (c, i) => {
    const ng = ngRow(c)
    return `<div class="calc-row" data-i="${i}">
      <div class="calc-name">
        ${c.code && !c.manual ? `<div class="small"><strong class="mono">${esc(c.code)}</strong>${c.result ? ` <span class="pill ${c.expected === c.result ? 'good' : 'warn'}">result ${esc(c.result)}</span>` : repeatCodes.has(c.code) ? ' <span class="pill warn" title="Already in your grade history. The new grade replaces the old one.">repeat</span>' : ''}</div>` : ''}
        <input data-calc="title" data-i="${i}" value="${esc(c.title)}" placeholder="Course name" aria-label="Course name">
      </div>
      <label class="calc-credits"><span class="muted small">Credits</span><input data-calc="credits" data-i="${i}" type="number" min="0" max="30" step="0.5" inputmode="decimal" value="${esc(c.credits)}" placeholder="0"></label>
      <label class="calc-grade"><span class="muted small">Expected</span>${ng
        ? '<span class="pill" style="padding:7px 10px">Credits only</span>'
        : `<select data-calc="expected" data-i="${i}" aria-label="Expected grade"><option value="">Grade</option>${LETTERS.map((l) => `<option ${c.expected === l ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</label>
      <label class="calc-ng small"><input type="checkbox" data-calc="ng" data-i="${i}" ${ng ? 'checked' : ''}> Non-graded</label>
      <button class="ghost sm calc-del" data-action="del-current" data-i="${i}" aria-label="Remove course">Remove</button>
    </div>`
  }

  return `
  <div class="page-head"><div><h1>GPA calculator</h1><p class="muted">Enter each course's name, credits and expected grade. Tick non-graded for NGCR courses: they count toward credits but not GPA.</p></div>
    <div class="daytabs" style="margin:0">${CALC_SEMS.map((k) => `<button data-action="calc-sem" data-v="${k}" class="${mode === k ? 'active' : ''}">${titles[k].split(' ')[0]}<span class="small" style="opacity:.75"> · ${esc(names[k].replace(/ Semester/, ''))}</span></button>`).join('')}</div></div>
  <div class="notice" style="margin-bottom:16px">${notes[mode]}</div>
  <div class="grid cols-3-1">
    <div class="card">
      <div class="card-head"><div><h2>${titles[mode]}</h2><div class="muted small">${esc(names[mode])}</div></div>
        <div class="row">
          <button class="sm" data-action="scenario" data-s="S">All S</button>
          <button class="sm" data-action="scenario" data-s="A">All A</button>
          <button class="sm" data-action="scenario" data-s="oneB">One B, rest S</button>
          <button class="sm ghost" data-action="scenario" data-s="clear">Clear grades</button>
        </div></div>
      <div class="calc-list">${list.map(row).join('')}</div>
      <div class="row" style="margin-top:14px">
        <button class="primary" data-action="add-row">Add course</button>
        <span class="muted small">${list.filter((c) => Number(c.credits) > 0).length} courses · ${list.reduce((a, c) => a + (Number(c.credits) || 0), 0)} credits${list.some(ngRow) ? ` (${list.filter(ngRow).reduce((a, c) => a + (Number(c.credits) || 0), 0)} non-graded)` : ''}</span>
      </div>
    </div>
    <div class="stack">
      <div class="card" id="calc-results">${calcResultsHtml()}</div>
      <div class="card">
        <h2 style="margin-bottom:10px">Target CGPA</h2>
        <form class="row" data-form="target"><input name="target" type="number" min="0" max="10" step="0.01" placeholder="e.g. 9.70" value="${esc(state.target ?? '')}" style="width:110px"><button type="submit">Calculate</button></form>
        <div style="margin-top:12px" id="calc-target">${calcTargetHtml()}</div>
      </div>
      <div class="card small muted">Scale: ${Object.entries(GRADE_POINTS).filter(([k]) => k !== 'N').map(([k, v]) => `${k}=${v}`).join(' · ')}. F counts as 0 until cleared. A repeated course's latest grade replaces the earlier one. Non-graded (NGCR) courses add credits but are left out of SGPA and CGPA.</div>
    </div>
  </div>`
}

function viewGrades() {
  const d = state.data
  const grades = d.grades || []
  const s = academicStats(d)
  const effIdx = new Set(s.effective.map((c) => c._i))
  const sems = new Map()
  grades.forEach((g, i) => {
    const k = semesterLabel(g.examMonth)
    if (!sems.has(k)) sems.set(k, [])
    sems.get(k).push({ ...g, _i: i })
  })
  const semInfo = Object.fromEntries(s.bySemester.map((x) => [x.label, x]))
  const ordered = s.bySemester.map((x) => x.label).filter((l) => sems.has(l)).reverse()

  const status = (g, i) => {
    if (!effIdx.has(i) && isGraded(g.grade)) return '<span class="pill">replaced</span>'
    if (isFail(g.grade)) return '<span class="pill bad">to clear</span>'
    if (isNonGraded(g) && earnsCredit(g)) return '<span class="pill accent">non-graded</span>'
    if (earnsCredit(g)) return '<span class="pill good">earned</span>'
    return `<span class="pill">${esc(g.grade || '—')}</span>`
  }

  return `
  <div class="page-head"><div><h1>Grade history</h1><p class="muted">${grades.length} attempts · ${s.effective.length} courses · CGPA ${fmt(s.cgpa)} (computed, non-graded excluded)</p></div></div>
  ${grades.length ? ordered.map((label) => {
    const info = semInfo[label]
    return `<div class="card">
      <div class="card-head"><h2>${esc(label)}</h2><span class="pill accent">SGPA ${fmt(info?.sgpa)} · ${info?.credits ?? 0} cr</span></div>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Course</th><th>Type</th><th>Exam</th><th class="num">Credits</th><th>Grade</th><th>Status</th><th></th></tr></thead>
      <tbody>${sems.get(label).map((g) => `<tr class="${!effIdx.has(g._i) && isGraded(g.grade) ? 'superseded' : ''}">
        <td class="mono small">${esc(g.code)}</td><td>${esc(g.title)}</td><td class="small muted">${esc(g.type)}</td><td class="small muted">${esc(g.examMonth)}</td>
        <td class="num">${esc(g.credits)}</td><td class="grade">${esc(g.grade)}</td><td>${status(g, g._i)}</td>
        <td><button class="ghost sm" data-action="del-grade" data-i="${g._i}" >Delete</button></td></tr>`).join('')}</tbody></table></div></div>`
  }).join('') : noData('your grade history')}
  <div class="card">
    <h2 style="margin-bottom:12px">Add a course</h2>
    <form class="row" data-form="add-grade">
      <input name="code" placeholder="Code" required style="width:120px">
      <input name="title" placeholder="Course name" style="flex:1;min-width:140px">
      <input name="credits" type="number" min="0" max="30" step="0.5" placeholder="Credits" required style="width:90px">
      <select name="grade" required>${[...LETTERS, 'N', 'P'].map((l) => `<option>${l}</option>`).join('')}</select>
      <input name="examMonth" placeholder="Exam month (Nov-2025)" style="width:180px">
      <label class="small muted"><input type="checkbox" name="ng"> Non-graded (NGCR)</label>
      <button class="primary" type="submit">Add</button>
    </form>
  </div>`
}

function semesterBar(d, semId) {
  const tts = sortSemesters(d.timetables || [])
  if (!tts.length) return ''
  const { previousSemId, currentSemId, upcomingSemId } = d.settings || {}
  const tag = (id) => (id === currentSemId ? ' (current)' : id === upcomingSemId ? ' (upcoming)' : id === previousSemId ? ' (previous)' : '')
  return `<div class="row">
    <select data-bind="tt-sem" aria-label="Semester">${tts.map((t) => `<option value="${esc(t.id)}" ${t.id === semId ? 'selected' : ''}>${esc(t.name)}${tag(t.id)}</option>`).join('')}</select>
    ${semId !== currentSemId ? `<button class="sm" data-action="set-sem" data-role="current" data-id="${esc(semId)}">Make current</button>` : ''}
    ${semId !== upcomingSemId ? `<button class="sm" data-action="set-sem" data-role="upcoming" data-id="${esc(semId)}">Make upcoming</button>` : ''}
    ${semId !== previousSemId ? `<button class="sm" data-action="set-sem" data-role="previous" data-id="${esc(semId)}">Make previous</button>` : ''}
  </div>`
}

function viewTimetable() {
  const d = state.data
  const tts = d.timetables || []
  const semId = state.ttSem && tts.some((t) => t.id === state.ttSem) ? state.ttSem : d.settings?.currentSemId || tts[0]?.id
  const sem = tts.find((t) => t.id === semId)
  const entries = sem ? sem.entries : d.timetable?.entries || []
  const current = sem ? sem.courses : d.current || []
  const day = state.day || (DAYS.includes(todayCode()) ? todayCode() : 'MON')
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const isToday = day === todayCode()

  if (!entries.length) {
    return `<div class="page-head"><div><h1>Timetable</h1></div>${semesterBar(d, semId)}</div>
    ${current.length ? `<div class="notice warn" style="margin-bottom:16px">Courses for this semester were found, but not the weekly class grid. VTOP may not have published it yet.</div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Course</th><th>Slot</th><th>Venue</th><th>Faculty</th></tr></thead><tbody>
      ${current.map((c) => `<tr><td><strong class="mono small">${esc(c.code)}</strong> ${esc(c.title)}</td><td class="mono small">${esc(c.slot)}</td><td>${esc(c.venue)}</td><td class="small">${esc(c.faculty)}</td></tr>`).join('')}
      </tbody></table></div></div>` : noData('your timetable')}`
  }

  const list = entries.filter((e) => e.day === day).sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
  const items = []
  let cursor = 8 * 60
  for (const e of list) {
    const st = toMinutes(e.start), en = toMinutes(e.end)
    if (st - cursor >= 50) items.push({ free: true, from: cursor, to: st })
    items.push(e)
    cursor = Math.max(cursor, en)
  }
  if (list.length && 19 * 60 + 30 - cursor >= 50) items.push({ free: true, from: cursor, to: 19 * 60 + 30 })
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const fac = Object.fromEntries(current.map((c) => [c.code, c.faculty]))

  return `
  <div class="page-head"><div><h1>Timetable</h1><p class="muted">${sem ? esc(sem.name) + ' · ' : ''}${entries.length} classes a week · free slots of 50+ minutes shown between classes</p></div>${semesterBar(d, semId)}</div>
  <div class="daytabs">${DAYS.map((k) => `<button data-action="day" data-d="${k}" class="${k === day ? 'active' : ''}">${DAY_NAMES[k].slice(0, 3)}${k === todayCode() ? ' · today' : ''}</button>`).join('')}</div>
  <div class="card">
    <h2 style="margin-bottom:14px">${DAY_NAMES[day]}</h2>
    ${list.length ? `<div class="class-list">${items.map((e) => e.free
      ? `<div class="class-item free"><div class="time">${hm(e.from)}–${hm(e.to)}</div><div>Free · ${Math.round((e.to - e.from) / 6) / 10} h</div><div></div></div>`
      : (() => {
        const now = isToday && toMinutes(e.start) <= nowMin && nowMin < toMinutes(e.end)
        return `<div class="class-item ${now ? 'now' : ''}"><div class="time">${esc(e.start)}<br><span class="muted">${esc(e.end)}</span></div>
        <div><strong>${esc(e.code)}</strong> ${esc(e.title || '')}<div class="muted small">${esc(fac[e.code] || '')}</div></div>
        <div style="text-align:right"><span class="pill ${e.kind === 'Lab' ? 'good' : 'accent'}">${esc(e.kind)}</span><div class="small mono" style="margin-top:4px">${esc(e.venue)} · ${esc(e.slot)}</div></div></div>`
      })()).join('')}</div>` : '<p class="muted">No classes. Enjoy the day.</p>'}
  </div>
  <div class="card"><h2 style="margin-bottom:14px">Week at a glance</h2>
    <div class="week">${DAYS.map((k) => `<div class="day ${k === todayCode() ? 'today' : ''}"><h3>${DAY_NAMES[k].slice(0, 3)}</h3>
      ${entries.filter((e) => e.day === k).map((e) => `<div class="slot ${e.kind === 'Lab' ? 'lab' : ''}"><div class="mono">${esc(e.start)}</div><strong>${esc(e.code)}</strong><div class="muted">${esc(e.venue)}</div></div>`).join('') || '<div class="muted small">—</div>'}
    </div>`).join('')}</div></div>`
}

function viewCurriculum() {
  const d = state.data
  const s = academicStats(d)
  const cats = d.curriculum?.categories || []
  const failedCredits = s.failed.reduce((a, c) => a + c.credits, 0)
  return `
  <div class="page-head"><div><h1>Curriculum</h1><p class="muted">How far you are from graduating</p></div></div>
  <div class="grid cols-2">
    <div class="card">
      <h2 style="margin-bottom:12px">Credit summary</h2>
      <table><tbody>
        <tr><td>Total curriculum requirement</td><td class="num"><strong>${s.totalRequired}</strong></td></tr>
        <tr><td>Successfully completed</td><td class="num">${fmt(s.earned, 1)}</td></tr>
        <tr><td>Remaining</td><td class="num">${fmt(s.pending, 1)}</td></tr>
        <tr><td>Currently registered</td><td class="num">${fmt(s.currentCredits, 1)}</td></tr>
        <tr><td>Pending after current semester</td><td class="num"><strong>${fmt(s.pendingAfterCurrent, 1)}</strong></td></tr>
        <tr><td class="muted">of which non-graded (NGCR)</td><td class="num muted">${fmt(s.ngEarned, 1)}</td></tr>
        <tr><td>Failed, to be cleared</td><td class="num">${fmt(failedCredits, 1)}</td></tr>
        ${d.summary?.creditsEarned != null ? `<tr><td class="muted">Credits earned (VTOP's figure)</td><td class="num muted">${d.summary.creditsEarned}</td></tr>` : ''}
      </tbody></table>
      <form class="row" data-form="total" style="margin-top:16px">
        <label class="field" style="flex:1">Total credits required for your programme
          <input name="total" type="number" min="1" max="400" step="0.5" value="${esc(d.settings?.totalRequired || d.curriculum?.totalRequired || 160)}"></label>
        <button type="submit" style="align-self:end">Save</button>
      </form>
      ${s.pendingAfterCurrent === 0 && s.earned > 0 ? '<div class="notice good" style="margin-top:14px">If you pass everything this semester you meet the total credit requirement. Check each category below too.</div>' : ''}
    </div>
    <div class="card">
      <div class="card-head"><h2>By category</h2>${d.curriculum ? `<span class="muted small">Updated ${timeAgo(state.updated.curriculum)}</span>` : ''}</div>
      ${cats.length ? cats.map(catRow).join('') : `<p class="muted">VTOP shows category-wise credits (Foundation Core, Discipline Core, Electives …) on VTOP. Sync from VTOP to bring them in.</p>`}
    </div>
  </div>`
}

function syncReport(r) {
  const rep = r.report
  if (!rep) return ''
  const empty = rep.timetablePages.filter((t) => !t.courses && !t.classes)
  return `${empty.length ? `<p class="small" style="margin:10px 0 0;color:var(--warn)">No courses found for: ${empty.map((t) => esc(t.name)).join(', ')}. VTOP may not have a timetable for ${empty.length > 1 ? 'those semesters' : 'that semester'}. If you were registered then, download the debug file below and send it over.</p>` : ''}
  <details style="margin-top:12px" ${r.errors?.length || empty.length ? 'open' : ''}>
    <summary class="small" style="cursor:pointer;font-weight:600">Sync details</summary>
    <p class="small muted" style="margin:8px 0">VTOP listed ${rep.semestersListed} semester${rep.semestersListed === 1 ? '' : 's'} on the Time Table page.</p>
    ${rep.timetablePages.length ? `<div class="table-wrap"><table><thead><tr><th>Semester</th><th class="num">Page</th><th class="num">Tables</th><th class="num">Courses</th><th class="num">Classes</th></tr></thead><tbody>
      ${rep.timetablePages.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.kb} KB</td><td class="num">${t.tables}</td><td class="num">${t.courses}</td><td class="num">${t.classes}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Request</th><th>Path</th><th class="num">Status</th><th class="num">Size</th><th class="num">Tables</th></tr></thead><tbody>
      ${rep.steps.map((x) => `<tr><td class="small">${esc(x.label)}</td><td class="small mono">${esc(x.path)}</td><td class="num">${x.status}</td><td class="num">${x.kb} KB</td><td class="num">${x.tables}</td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:10px"><button class="sm" data-action="download-debug">Download debug file</button>
      <span class="muted small">Contains your VTOP pages (personal data). It stays on your computer unless you share it.</span></div>
  </details>`
}

function viewImport() {
  const pv = state.preview
  const sy = state.sync
  const LABELS = {
    grades: (v) => `${v.length} grade history rows`,
    current: (v) => `${v.length} courses from a timetable`,
    timetable: (v) => `${v.entries.length} weekly classes`,
    curriculum: (v) => `${v.categories.length} curriculum categories · ${v.totalRequired} credits required`,
    summary: (v) => `VTOP summary · CGPA ${v.cgpa}, ${v.creditsEarned} credits earned`,
    profile: (v) => `Registration number ${v.regNo}`,
  }
  const existing = (k) => {
    const v = state.data[k]
    if (!v || k === 'current' || k === 'timetable') return ''
    if (k === 'grades') {
      const have = new Set(v.map(gradeKey))
      const n = pv.parsed.grades.filter((g) => !have.has(gradeKey(g))).length
      return `adds ${n} new, updates ${pv.parsed.grades.length - n}`
    }
    return Array.isArray(v) ? `replaces ${v.length} saved` : 'replaces saved'
  }
  const previewCard = pv ? `
    <div class="card" id="preview">
      <div class="card-head"><h2>Found in ${esc(pv.source)}</h2><button class="ghost sm" data-action="discard">Discard</button></div>
      ${Object.keys(pv.parsed).length ? `<div class="found">${Object.entries(pv.parsed).filter(([k]) => LABELS[k]).map(([k, v]) => `
        <label class="found-item"><span><input type="checkbox" data-pick="${k}" checked> ${esc(LABELS[k](v))}</span><span class="muted small">${existing(k)}</span></label>`).join('')}</div>
        ${pv.parsed.current || pv.parsed.timetable ? (() => {
          const cal = calendarSemesters()
          const def = (pv.parsed.semester && roleOf(pv.parsed.semester.name)) || 'current'
          return `<label class="field" style="margin-top:14px">This timetable is for
            <select data-import-sem>${['previous', 'current', 'upcoming'].map((k) => `<option value="${k}" ${k === def ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)} semester · ${cal[k].label}</option>`).join('')}</select>
            ${pv.parsed.semester ? `<span class="small muted" style="font-weight:400">The page says: ${esc(pv.parsed.semester.name)}</span>` : ''}</label>`
        })() : ''}
        <div class="row" style="margin-top:14px"><button class="primary" data-action="save-import">Save to my dashboard</button></div>`
        : `<div class="notice warn">No grade, timetable or curriculum tables found in that.
            <div class="row" style="margin-top:10px"><button class="sm" data-action="download-paste">Download what was pasted</button><span class="small muted">Send this file over so the reader can be fixed. It contains your VTOP page.</span></div></div>`}
    </div>` : ''

  const r = sy.result
  const resultBox = r ? (r.ok
    ? `<div class="notice good" style="margin-top:16px"><strong>Synced.</strong> ${r.grades} grade rows (${r.newGrades} new) · timetables for ${r.semesters} of ${r.report?.semestersListed ?? r.semesters} semesters${r.curriculum ? ' · curriculum' : ''}.
        ${r.current ? `<div class="small" style="margin-top:4px">Current semester: ${esc(r.current)}${r.upcoming ? ` · Upcoming: ${esc(r.upcoming)}` : ''}</div>` : ''}
        ${r.errors?.length ? `<div class="small" style="margin-top:6px;color:var(--warn)">Some pages couldn't be read: ${r.errors.map(esc).join('; ')}</div>` : ''}</div>
       ${syncReport(r)}`
    : `<div class="notice ${r.needLogin ? 'warn' : 'bad'}" style="margin-top:16px">${esc(r.error || 'Sync failed')}</div>`) : ''

  const syncCard = ext.version ? `
    <div class="card">
      <h2 style="margin-bottom:6px">Sync from VTOP</h2>
      <p class="muted" style="margin:0 0 16px">Pulls grade history for every semester, your curriculum, and the timetable for every semester on VTOP, including current and upcoming. Stay logged in to VTOP in another tab.</p>
      <div class="row">${syncButton()}${sy.running ? `<span class="muted small">${esc(sy.progress)}</span>` : ''}</div>
      ${resultBox}
      <p class="muted small" style="margin:14px 0 0">Last synced ${timeAgo(state.updated.timetables || state.updated.grades)}.</p>
    </div>` : `
    <div class="card">
      <h2 style="margin-bottom:6px">Set up one-click sync</h2>
      <p class="muted" style="margin:0 0 14px">A small browser extension lets this site read your VTOP data while you're logged in to VTOP. Your VTOP password never comes here. One-time setup, about a minute:</p>
      <ol class="steps">
        <li>Download the extension folder <a href="/vit-dashboard-sync.zip" download>vit-dashboard-sync.zip</a> and unzip it.</li>
        <li>Open <span class="mono small">chrome://extensions</span> and turn on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> and choose the unzipped folder.</li>
        <li>Reload this page. A <b>Sync from VTOP</b> button appears here and in the top bar.</li>
      </ol>
      <p class="muted small" style="margin:14px 0 0">Works in Chrome, Edge and Brave on a computer.</p>
    </div>`

  const pasteBody = `
    <ol class="steps small" style="margin-bottom:16px">
      <li>Log in to VTOP and open <b>Examination &gt; Grade History</b>. This one page has every semester's grades, your CGPA and curriculum credits.</li>
      <li>Press <b>Ctrl+A</b> then <b>Ctrl+C</b> (on Mac: Cmd+A, Cmd+C), then click the box below and press <b>Ctrl+V</b>. Grades are sorted into Fall / Winter semesters, and the Previous semester tab in the GPA calculator fills itself.</li>
      <li>For timetables: open <b>Academics &gt; Time Table</b>, pick a semester, copy and paste the same way, then choose whether it's your previous, current or upcoming semester. Repeat for each semester you want.</li>
    </ol>
    <div class="grid cols-2">
      <div>
        <h3 style="margin-bottom:6px">Paste here</h3>
        <div class="paste-zone" contenteditable="true" data-paste role="textbox" aria-label="Paste the VTOP page here">Click here and paste (Ctrl/Cmd + V)</div>
      </div>
      <div>
        <h3 style="margin-bottom:6px">Or upload a saved page</h3>
        <p class="muted small" style="margin-top:0">On VTOP press Ctrl/Cmd + S, save as "Webpage, HTML only", then upload it here.</p>
        <label class="drop" data-drop><input type="file" accept=".html,.htm,text/html" data-file multiple hidden>Choose file or drop it here</label>
      </div>
    </div>`

  return `
  <div class="page-head"><div><h1>Sync VTOP</h1><p class="muted">Log in to VTOP yourself. Your VTOP password is never sent here or stored.</p></div></div>
  ${previewCard}
  ${ext.version ? `${syncCard}
  <details class="card"><summary style="cursor:pointer;font-weight:600">Copy and paste instead</summary><div style="margin-top:14px">${pasteBody}</div></details>`
  : `<div class="card"><h2 style="margin-bottom:6px">Copy and paste from VTOP</h2><p class="muted" style="margin:0 0 14px">No install needed. Takes about a minute.</p>${pasteBody}</div>
  <details class="card"><summary style="cursor:pointer;font-weight:600">One-click sync with the browser extension (optional)</summary><div style="margin-top:14px">${syncCard.replace(/^\s*<div class="card">|<\/div>\s*$/g, '')}</div></details>`}`
}

function viewAccount() {
  const d = state.data
  return `
  <div class="page-head"><div><h1>Account</h1><p class="muted">${esc(state.user.email)}</p></div><button data-action="logout">Sign out</button></div>
  <div class="grid cols-2">
    <div class="card">
      <h2 style="margin-bottom:12px">Profile</h2>
      <form class="form" data-form="profile">
        <label class="field">Registration number<input name="regNo" value="${esc(d.profile?.regNo || '')}" placeholder="22BCE1234"></label>
        <label class="field">Programme<input name="programme" value="${esc(d.profile?.programme || '')}" placeholder="B.Tech CSE"></label>
        <div><button class="primary" type="submit">Save</button></div>
      </form>
    </div>
    <div class="card">
      <h2 style="margin-bottom:12px">Your data</h2>
      <p class="muted small">Stored: ${Object.keys(d).length ? Object.keys(d).map((k) => `${k} (${timeAgo(state.updated[k])})`).join(', ') : 'nothing yet'}.</p>
      <div class="row"><button data-action="export">Download as JSON</button><button class="danger" data-action="clear-data">Delete all academic data</button></div>
      <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">
      <form class="row" data-form="delete-account"><input name="password" type="password" placeholder="Password" required autocomplete="current-password"><button class="danger" type="submit">Delete account</button></form>
    </div>
  </div>`
}

const authBrand = `<div class="brand" style="justify-content:center"><span class="brand-mark"><svg width="16" height="16" viewBox="0 0 32 32"><path d="M5 23l6-14 5 10 4-7 7 11" stroke="white" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>VIT Academic Dashboard</div>`

function viewForgot() {
  return `<div class="auth"><div class="card">${authBrand}
    <h2 style="margin:22px 0 6px">Reset your password</h2>
    <p class="muted small" style="margin:0 0 18px">Enter your account email. We'll send you a link to choose a new password.</p>
    ${state.forgotSent ? `<div class="notice good">If an account exists for that email, a reset link is on its way. It works for 30 minutes. Check your spam folder too.</div>
      <p style="margin:18px 0 0"><a href="#" data-action="auth-mode" data-m="login">Back to sign in</a></p>` : `
    <form class="form" data-form="forgot">
      <label class="field">Email<input name="email" type="email" required autocomplete="email"></label>
      <div class="error" data-error></div>
      <button class="primary" type="submit" style="justify-content:center">Send reset link</button>
      <a href="#" data-action="auth-mode" data-m="login" class="small" style="text-align:center">Back to sign in</a>
    </form>`}
  </div></div>`
}

function viewReset(token) {
  return `<div class="auth"><div class="card">${authBrand}
    <h2 style="margin:22px 0 6px">Choose a new password</h2>
    <p class="muted small" style="margin:0 0 18px">This signs you out on every other device.</p>
    <form class="form" data-form="reset">
      <input type="hidden" name="token" value="${esc(token)}">
      <label class="field">New password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field">Confirm new password<input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>
      <div class="error" data-error></div>
      <button class="primary" type="submit" style="justify-content:center">Save new password</button>
      <a href="#/" class="small" style="text-align:center">Back to sign in</a>
    </form>
  </div></div>`
}

function viewAuth(mode = state.authMode || 'login') {
  if (mode === 'forgot') return viewForgot()
  return `<div class="auth"><div class="card">
    ${authBrand}
    <p class="muted small" style="text-align:center;margin:8px 0 0">Grades, credits, timetable and CGPA from VTOP, in one place.</p>
    ${state.pendingImport ? '<div class="notice" style="margin-top:16px">VTOP data received. Sign in to review and save it.</div>' : ''}
    <div class="switch"><button data-action="auth-mode" data-m="login" class="${mode === 'login' ? 'on' : ''}">Sign in</button><button data-action="auth-mode" data-m="register" class="${mode === 'register' ? 'on' : ''}">Create account</button></div>
    <form class="form" data-form="${mode}">
      ${mode === 'register' ? '<label class="field">Name<input name="name" autocomplete="name"></label>' : ''}
      <label class="field">Email<input name="email" type="email" required autocomplete="email"></label>
      <label class="field">Password<input name="password" type="password" required minlength="${mode === 'register' ? 8 : 1}" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}"></label>
      ${mode === 'login' ? '<a href="#" data-action="auth-mode" data-m="forgot" class="small" style="justify-self:end;margin-top:-6px">Forgot password?</a>' : ''}
      <div class="error" data-error></div>
      <button class="primary" type="submit" style="justify-content:center">${mode === 'register' ? 'Create account' : 'Sign in'}</button>
      ${mode === 'register' ? '<p class="muted small" style="margin:0">This is a separate account for this dashboard. Don\'t reuse your VTOP password.</p>' : ''}
    </form></div></div>`
}

const VIEWS = { builder: () => viewBuilder(state.data), overview: viewOverview, calculator: viewCalculator, planner: () => viewPlanner(state.data), credits: () => viewCredits(state.data), grades: viewGrades, timetable: viewTimetable, curriculum: viewCurriculum, import: viewImport, account: viewAccount }

function render() {
  // Shared timetable links open for anyone, signed in or not.
  const shareId = location.hash.match(/^#\/share\/([A-Za-z0-9_-]{6,20})$/)?.[1]
  if (shareId) {
    if (state.shareId !== shareId) {
      state.shareId = shareId; state.share = null
      api('GET', `/api/share/${shareId}`).then((r) => { state.share = r; render() }).catch((e) => { state.share = { error: e.message }; render() })
    }
    app.innerHTML = `<header class="topbar no-print"><div class="topbar-inner"><a class="brand" href="#/"><span class="brand-mark"><svg width="16" height="16" viewBox="0 0 32 32"><path d="M5 23l6-14 5 10 4-7 7 11" stroke="white" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>VIT Academics</span></a></div></header>${viewShared(state.share)}`
    return
  }
  const resetToken = location.hash.match(/^#\/reset\/([A-Za-z0-9_-]{20,})$/)?.[1]
  if (resetToken) { app.innerHTML = viewReset(resetToken); return }
  if (!state.user) { app.innerHTML = viewAuth(); return }
  const v = VIEWS[route()] || viewOverview
  const scroll = window.scrollY
  app.innerHTML = shell(v())
  window.scrollTo(0, scroll)
}

// ---------- import processing ----------
const gradeKey = (g) => `${g.code}|${String(g.examMonth || '').toLowerCase()}`
function importHtml(html, source) {
  state.pendingImport = { html, source }
  runImport()
  render()
  document.getElementById('preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function saveImport() {
  const pv = state.preview
  if (!pv) return
  const picked = [...document.querySelectorAll('[data-pick]')].filter((x) => x.checked).map((x) => x.dataset.pick)
  const role = document.querySelector('[data-import-sem]')?.value || 'current'
  // Timetable pages are stored per semester, then copied into the chosen calculator tab.
  if (picked.includes('current') || picked.includes('timetable')) {
    const label = calendarSemesters()[role].label
    const name = pv.parsed.semester && roleOf(pv.parsed.semester.name) === role ? pv.parsed.semester.name : vtopName(label)
    const id = pv.parsed.semester && roleOf(pv.parsed.semester.name) === role ? pv.parsed.semester.id : `pasted:${label}`
    const entry = { id, name, courses: picked.includes('current') ? pv.parsed.current || [] : [], entries: picked.includes('timetable') ? pv.parsed.timetable?.entries || [] : [] }
    const others = (state.data.timetables || []).filter((t) => t.id !== id && roleOf(t.name) !== role)
    await save('timetables', sortSemesters([...others, entry]))
    await save('settings', { ...(state.data.settings || {}), [`${role}SemId`]: id })
    await applySemesterChoice(state.data, save)
  }
  for (const k of picked.filter((x) => x !== 'current' && x !== 'timetable')) {
    let v = pv.parsed[k]
    if (k === 'profile') v = { ...(state.data.profile || {}), ...v }
    if (k === 'grades') {
      // Merge: keep saved rows, update ones that match code + exam month, add the rest.
      const merged = new Map((state.data.grades || []).map((g) => [gradeKey(g), g]))
      for (const g of v) merged.set(gradeKey(g), { ...merged.get(gradeKey(g)), ...g })
      v = [...merged.values()]
    }
    await save(k, v)
  }
  state.preview = null
  toast(`Saved ${picked.length} item${picked.length === 1 ? '' : 's'}`)
  location.hash = '#/overview'
  render()
}

// ---------- events ----------
const bctx = { state, save, saveSoon: (k) => saveSoon(k), render: () => render(), toast: (m) => toast(m), api: (...a) => api(...a) }
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  const a = el.dataset.action
  const d = state.data
  if (a === 'print-page') { window.print(); return }
  if (a.startsWith('b-') && (await builderClick(a, el, bctx))) return
  if (a === 'auth-mode') {
    e.preventDefault()
    state.authMode = el.dataset.m
    state.forgotSent = false
    if (location.hash.startsWith('#/reset/')) history.replaceState(null, '', location.pathname)
    render()
  }
  else if (a === 'add-row') {
    d[ck()] = d[ck()] || []
    d[ck()].push(blankCourse()); render()
    const inputs = document.querySelectorAll('[data-calc=title]'); inputs[inputs.length - 1]?.focus()
  } else if (a === 'scenario') {
    const cur = (d[ck()] || []).filter((c) => !ngRow(c))
    const s = el.dataset.s
    if (s === 'clear') cur.forEach((c) => (c.expected = ''))
    else if (s === 'oneB') {
      cur.forEach((c) => (c.expected = 'S'))
      const big = [...cur].sort((x, y) => y.credits - x.credits)[0]
      if (big) big.expected = 'B'
    } else cur.forEach((c) => (c.expected = s))
    render(); saveSoon(ck())
  } else if (a === 'apply-plan') {
    const { grades, list } = calcContext()
    const plan = gradePlan(grades, list, Number(state.target))
    if (plan) { list.forEach((c, i) => { if (plan[i]) c.expected = plan[i] }); render(); saveSoon(ck()) }
  } else if (a === 'del-current') {
    d[ck()].splice(+el.dataset.i, 1); render(); save(ck(), d[ck()].filter((c) => c.title || c.credits || c.code))
  } else if (a === 'del-grade') {
    d.grades.splice(+el.dataset.i, 1); render(); save('grades', d.grades)
  } else if (a === 'day') { state.day = el.dataset.d; render() }
  else if (a === 'calc-sem') { state.calcSem = el.dataset.v; render() }
  else if (a === 'sync') runSync()
  else if (a === 'cp-reset') {
    d.plan = { ...(d.plan || {}) }; delete d.plan.catAlloc; render(); save('plan', d.plan)
  } else if (a === 'cp-del-cat') {
    d.plan = { ...(d.plan || {}), customCats: [...(d.plan?.customCats || [])] }
    d.plan.customCats.splice(+el.dataset.i, 1); render(); save('plan', d.plan)
  }
  else if (a === 'plan-add-row') {
    const rows = ensureSemRows(d)
    const last = rows[rows.length - 1]?.label
    rows.push({ label: last ? nextSemesterLabels(last, 1)[0] : '', credits: '', sgpa: '' })
    render(); saveSoon('plan')
    const inputs = document.querySelectorAll('[data-semrow=credits]'); inputs[inputs.length - 1]?.focus()
  } else if (a === 'plan-del-row') {
    ensureSemRows(d).splice(+el.dataset.i, 1); render(); saveSoon('plan')
  } else if (a === 'plan-exp-all') {
    const v = document.querySelector('[data-exp-all]')?.value
    if (v === '' || v === undefined) return toast('Enter an SGPA first')
    const labels = [...document.querySelectorAll('[data-exp]')].map((x) => x.dataset.exp)
    d.plan = { ...(d.plan || {}), expected: Object.fromEntries(labels.map((l) => [l, Math.min(Math.max(Number(v), 0), 10)])) }
    document.getElementById('plan-exp').innerHTML = expectedCardHtml(d); save('plan', d.plan)
  } else if (a === 'plan-exp-clear') {
    d.plan = { ...(d.plan || {}), expected: {} }
    document.getElementById('plan-exp').innerHTML = expectedCardHtml(d); save('plan', d.plan)
  } else if (a === 'plan-reset-rows') {
    delete d.plan.semRows; render(); save('plan', d.plan)
  }
  else if (a === 'download-paste') {
    const blob = new Blob([state.preview?.html || ''], { type: 'text/html' })
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'vtop-pasted-page.html' })
    link.click(); URL.revokeObjectURL(link.href)
  } else if (a === 'download-debug') {
    const raw = state.sync.raw || {}
    const blob = new Blob([JSON.stringify({ when: new Date().toISOString(), report: state.sync.result?.report, errors: state.sync.result?.errors, raw }, null, 1)], { type: 'application/json' })
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'vtop-sync-debug.json' })
    link.click(); URL.revokeObjectURL(link.href)
  }
  else if (a === 'set-sem') {
    const st = { ...(d.settings || {}), manualSems: true }
    for (const k of ['previousSemId', 'currentSemId', 'upcomingSemId']) if (st[k] === el.dataset.id) st[k] = null
    st[`${el.dataset.role}SemId`] = el.dataset.id
    await save('settings', st)
    await applySemesterChoice(state.data, save)
    toast(`${el.dataset.role[0].toUpperCase() + el.dataset.role.slice(1)} semester updated`); render()
  }
  else if (a === 'discard') { state.preview = null; render() }
  else if (a === 'save-import') { el.disabled = true; await saveImport() }
  else if (a === 'logout') {
    await api('POST', '/api/logout').catch(() => {})
    Object.assign(state, { user: null, data: {}, updated: {} }); location.hash = ''; render()
  } else if (a === 'export') {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'vit-academics.json' })
    link.click(); URL.revokeObjectURL(link.href)
  } else if (a === 'clear-data') {
    if (!confirm('Delete all your stored grades, timetable and curriculum? Your account stays. This cannot be undone.')) return
    await api('DELETE', '/api/data'); state.data = {}; state.updated = {}; toast('All academic data deleted'); render()
  }
})

app.addEventListener('change', (e) => {
  const el = e.target
  if (builderChange(el, bctx)) return
  if (el.dataset.bind === 'tt-sem') { state.ttSem = el.value; render(); return }
  if (el.dataset.calc === 'ng') {
    const c = state.data[ck()][+el.dataset.i]
    c.ng = el.checked
    c.expected = el.checked ? 'P' : c.expected === 'P' ? '' : c.expected
    render(); saveSoon(ck())
  }
  if (el.dataset.file !== undefined) readFiles(el.files)
})

// Planner fields: update results as you type (keeps focus).
function refreshPlanner() {
  const out = document.getElementById('plan-out')
  if (out) out.innerHTML = plannerResultsHtml(state.data)
  const rc = document.getElementById('plan-rows-cgpa')
  if (rc) rc.textContent = fmt(rowsCgpa(state.data.plan?.semRows || []))
  const ex = document.getElementById('plan-exp')
  if (ex) ex.innerHTML = expectedCardHtml(state.data)
}
app.addEventListener('input', (e) => {
  const el = e.target
  if (builderInput(el, bctx)) return
  if (el.dataset?.cpalloc) {
    const [sem, cat] = el.dataset.cpalloc.split('|')
    const plan = (state.data.plan = { ...(state.data.plan || {}) })
    const alloc = (plan.catAlloc = { ...(plan.catAlloc || {}) })
    alloc[sem] = { ...(alloc[sem] || {}) }
    if (el.value === '') delete alloc[sem][cat]
    else alloc[sem][cat] = Number(el.value)
    refreshCredits(state.data); saveSoon('plan')
    return
  }
  if (el.dataset?.cpset) {
    const plan = (state.data.plan = { ...(state.data.plan || {}) })
    const k = el.dataset.cpset
    if (el.value === '' && k === 'completedSems') delete plan[k]
    else if (el.value !== '') plan[k] = Number(el.value)
    else return
    saveSoon('plan')
    // The number of semester columns can change: redraw, then put the cursor back.
    render()
    const again = document.querySelector(`[data-cpset="${k}"]`)
    if (again) { again.focus(); try { again.setSelectionRange(again.value.length, again.value.length) } catch {} }
    return
  }
  if (el.dataset?.plan) {
    const plan = (state.data.plan = { ...(state.data.plan || {}) })
    const k = el.dataset.plan
    if (el.value === '' && ['completedSems', 'totalRequired', 'ngRemaining', 'target'].includes(k)) delete plan[k]
    else plan[k] = el.value === '' ? '' : Number(el.value)
    refreshPlanner(); saveSoon('plan')
  } else if (el.dataset?.exp) {
    const plan = (state.data.plan = { ...(state.data.plan || {}) })
    plan.expected = { ...(plan.expected || {}) }
    if (el.value === '') delete plan.expected[el.dataset.exp]
    else plan.expected[el.dataset.exp] = Number(el.value)
    refreshExpectedNumbers(state.data); saveSoon('plan')
  } else if (el.dataset?.semrow) {
    const rows = ensureSemRows(state.data)
    const r = rows[+el.dataset.i]
    if (!r) return
    r[el.dataset.semrow] = el.dataset.semrow === 'label' ? el.value : el.value === '' ? '' : Number(el.value)
    refreshPlanner(); saveSoon('plan')
  }
})

// Calculator fields update the numbers as you type, without redrawing the rows (keeps focus).
app.addEventListener('input', (e) => {
  const el = e.target
  const f = el.dataset?.calc
  if (!f || f === 'ng') return
  const c = state.data[ck()]?.[+el.dataset.i]
  if (!c) return
  if (f === 'title') {
    c.title = el.value
    if (c.manual) c.code = (el.value.match(COURSE_CODE_RE)?.[1] || '').toUpperCase()
  } else if (f === 'credits') c.credits = el.value === '' ? '' : Number(el.value)
  else if (f === 'expected') c.expected = el.value
  refreshCalc()
  saveSoon(ck())
})

async function readFiles(files) {
  let html = ''
  for (const f of files) html += await f.text()
  if (html) importHtml(html, files.length > 1 ? `${files.length} files` : files[0].name)
}

app.addEventListener('dragover', (e) => { const z = e.target.closest('[data-drop]'); if (z) { e.preventDefault(); z.classList.add('over') } })
app.addEventListener('dragleave', (e) => e.target.closest('[data-drop]')?.classList.remove('over'))
app.addEventListener('drop', (e) => {
  const z = e.target.closest('[data-drop]')
  if (!z) return
  e.preventDefault(); z.classList.remove('over'); readFiles(e.dataTransfer.files)
})

app.addEventListener('paste', (e) => {
  if (!e.target.closest('[data-paste]')) return
  e.preventDefault()
  const html = e.clipboardData.getData('text/html')
  const text = e.clipboardData.getData('text/plain')
  importHtml(html && /<table/i.test(html) ? html : tsvToHtml(text || ''), 'pasted table')
})

app.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]')
  if (!form) return
  e.preventDefault()
  const f = Object.fromEntries(new FormData(form))
  const kind = form.dataset.form
  const d = state.data
  if (kind.startsWith('b-') && builderSubmit(kind, form, f, bctx)) return
  if (kind === 'cp-add-cat') {
    d.plan = { ...(d.plan || {}), customCats: [...(d.plan?.customCats || []), { name: f.name.trim(), required: Number(f.required) || 0, earned: Number(f.earned) || 0 }] }
    render(); save('plan', d.plan); return
  }
  try {
    if (kind === 'login' || kind === 'register') {
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true
      try {
        const r = await api('POST', `/api/${kind}`, f)
        state.user = r.user
        await loadMe()
        if (state.pendingImport) { runImport(); location.hash = '#/import' }
        render()
      } catch (err) { form.querySelector('[data-error]').textContent = err.message; btn.disabled = false }
    } else if (kind === 'forgot') {
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true
      try { await api('POST', '/api/forgot', { email: f.email }); state.forgotSent = true; render() }
      catch (err) { form.querySelector('[data-error]').textContent = err.message; btn.disabled = false }
    } else if (kind === 'reset') {
      const errEl = form.querySelector('[data-error]')
      if (f.password !== f.confirm) { errEl.textContent = "The two passwords don't match"; return }
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true
      try {
        await api('POST', '/api/reset', { token: f.token, password: f.password })
        await loadMe()
        history.replaceState(null, '', location.pathname + '#/overview')
        render(); toast('Password changed. You are signed in.')
      } catch (err) { errEl.textContent = err.message; btn.disabled = false }
    } else if (kind === 'add-grade') {
      d.grades = d.grades || []
      d.grades.push({ code: f.code.trim().toUpperCase(), title: f.title.trim(), type: '', credits: Number(f.credits) || 0, grade: f.grade, examMonth: f.examMonth.trim(), ng: !!f.ng })
      render(); save('grades', d.grades)
    } else if (kind === 'target') {
      state.target = f.target; refreshCalc()
    } else if (kind === 'total') {
      await save('settings', { ...(d.settings || {}), totalRequired: Number(f.total) || 160 }); toast('Saved'); render()
    } else if (kind === 'profile') {
      await save('profile', { ...(d.profile || {}), regNo: f.regNo.trim(), programme: f.programme.trim() }); toast('Saved'); render()
    } else if (kind === 'delete-account') {
      if (!confirm('Delete your account and all its data permanently?')) return
      await api('DELETE', '/api/account', { password: f.password })
      Object.assign(state, { user: null, data: {}, updated: {} }); location.hash = ''; render(); toast('Account deleted')
    }
  } catch (err) { toast(err.message) }
})

async function runSync() {
  if (state.sync.running) return
  state.sync = { running: true, progress: 'Starting…', result: null }
  if (route() !== 'import') location.hash = '#/import'
  render()
  const res = await requestSync((text) => {
    state.sync.progress = text
    const el = document.querySelector('[data-action=sync]')?.nextElementSibling
    if (el) el.textContent = text
  })
  let summary
  if (res?.ok) {
    try { summary = { ok: true, ...(await applySync(res, state.data, save)) } }
    catch (e) { console.error(e); summary = { ok: false, error: 'Synced, but the data could not be read: ' + e.message } }
  } else summary = { ok: false, error: res?.error || 'Sync failed', needLogin: res?.needLogin }
  state.sync = { running: false, progress: '', result: summary, raw: res }
  render()
  if (summary.ok) toast('VTOP data synced')
}

onExtChange(() => state.user && render())
window.addEventListener('hashchange', render)

async function loadMe() {
  const r = await api('GET', '/api/me')
  state.user = r.user
  state.data = r.data || {}
  state.updated = r.updated || {}
}

;(async () => {
  try { await loadMe() } catch { state.user = null }
  if (state.user && state.pendingImport) runImport()
  render()
})()
