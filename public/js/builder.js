// Timetable Builder (FFCS): choose subjects and faculty, generate every clash-free timetable.
import { generate, clashReasons, clashMatrix, optionMeetings } from './ffcs.js'
import { isValidSlot, normSlot, GRID, SLOT_MAP, splitSlots, meetingsClash, slotMeetings } from './slots.js'
import { calendarSemesters } from './semesters.js'
import { ext, requestAllocation } from './sync.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const PER_PAGE = 5
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// Transient (not saved): results and UI state.
export const ui = { report: false, out: null, page: 0, search: '', category: '', fetching: false, progress: '', fetchError: '', viewing: null, facultyFilter: '', grouped: false, picker: [] }

export const plan = (d) => (d.ffcs = { courses: [], filter: 'mixed', avoidWeekend: false, sameFaculty: true, earliest: '', latest: '', freeDay: false, maxLabDays: '', sameBuilding: false, dayOff: '', avoidFaculty: '', saved: [], ...(d.ffcs || {}) })
const optId = (o) => `${normSlot(o.slot)}|${o.faculty || ''}|${o.venue || ''}`
const vtopName = (label) => label.replace(/^(Fall|Winter) /, '$1 Semester ')

function studentLine(d) {
  const cal = calendarSemesters()
  const reg = d.profile?.regNo || ''
  const batch = /^\d{2}/.test(reg) ? 2000 + Number(reg.slice(0, 2)) : null
  const y = batch ? cal.upcoming.startYear - batch + 1 : null
  return { cal, reg, batch, year: y >= 1 && y <= 5 ? y : null }
}

// Subjects you've taken or are registered for (from synced timetables / calculator lists).
function existingCourses(d) {
  const map = new Map()
  const addFrom = (list) => (list || []).forEach((c) => {
    if (!c.code) return
    const m = map.get(c.code) || { code: c.code, title: c.title, credits: c.credits, options: [] }
    if (c.slot && !m.options.some((o) => normSlot(o.slot) === normSlot(c.slot) && o.faculty === c.faculty)) m.options.push({ slot: normSlot(c.slot), faculty: c.faculty || '', venue: c.venue || '' })
    map.set(c.code, m)
  })
  for (const t of d.timetables || []) addFrom(t.courses)
  addFrom(d.current); addFrom(d.upcoming)
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code))
}

// ---------- VTOP-style grid ----------
// cells: Map slot -> { label, cls }   clickable: slot picker mode   disabled: Set of slots
export function gridHtml(cells, { clickable = false, disabled = new Set() } = {}) {
  const head = (label, times) => `<tr class="g-head"><th rowspan="2" class="g-kind" colspan="2">${label}</th>${times.map((t, i) => (i === 6 ? '<th rowspan="2" class="g-lunch">Lunch</th>' : '') + `<th>${t ? t[0] : '-'}</th>`).join('')}</tr>
    <tr class="g-head">${times.map((t) => `<th>${t ? t[1] : '-'}</th>`).join('')}</tr>`
  const cell = (slot) => {
    if (slot === '-') return '<td class="g-none">-</td>'
    const c = cells.get(slot)
    const off = disabled.has(slot)
    const attrs = clickable && !off ? ` data-action="b-pick" data-slot="${slot}" role="button" tabindex="0"` : ''
    return `<td class="${c ? `g-on ${c.cls || ''}` : off ? 'g-off' : ''}${clickable && !off ? ' g-click' : ''}"${attrs}>${c?.label ? esc(c.label) : slot}</td>`
  }
  const rows = GRID.rows.map((r) => `
    <tr><th rowspan="2" class="g-day">${r.day}</th><th class="g-kind2">THEORY</th>${r.theory.map((s, i) => (i === 6 ? '<td rowspan="2" class="g-lunch">Lunch</td>' : '') + cell(s)).join('')}</tr>
    <tr><th class="g-kind2">LAB</th>${r.lab.map(cell).join('')}</tr>`).join('')
  const cols = `<colgroup><col style="width:48px"><col style="width:62px">${'<col>'.repeat(6)}<col style="width:34px">${'<col>'.repeat(7)}</colgroup>`
  return `<div class="g-wrap"><table class="g-table">${cols}${head('THEORY', GRID.theoryTimes)}${head('LAB', GRID.labTimes)}${rows}</table></div>`
}

function resultCells(r) {
  const cells = new Map()
  for (const p of r.picks) for (const s of splitSlots(p.slot)) cells.set(s, { label: `${s}-${p.code}${p.venue ? `-${p.venue}` : ''}`, cls: /^L\d/.test(s) ? 'g-lab' : '' })
  return cells
}

// ---------- hand-picked sections ----------
const roleOf = (o) => { const ms = optionMeetings(o); return ms.length && ms.every((m) => m.kind === 'Lab') ? 'lab' : 'theory' }
const isSplit = (c) => c.options.some((o) => roleOf(o) === 'lab' && optionMeetings(o).length) && c.options.some((o) => { const ms = optionMeetings(o); return ms.length && ms.every((m) => m.kind === 'Theory') })
// [{ course, opt }] for every section you picked by hand
function pickedList(p) {
  const out = []
  for (const c of p.courses) for (const id of [c.pick, c.pickLab]) {
    const o = id && c.options.find((x) => x.id === id)
    if (o) out.push({ course: c, opt: o })
  }
  return out
}
function statsOf(picks) {
  const ms = picks.flatMap((p) => optionMeetings(p))
  if (!ms.length) return { days: 0, gaps: 0, labDays: 0, start: NaN, end: NaN }
  const days = new Set(ms.map((m) => m.day))
  let gaps = 0
  for (const d of days) { const x = ms.filter((m) => m.day === d).sort((a, b) => a.s - b.s); for (let k = 1; k < x.length; k++) gaps += Math.max(x[k].s - x[k - 1].e, 0) }
  return { days: days.size, gaps, labDays: new Set(ms.filter((m) => m.kind === 'Lab').map((m) => m.day)).size, start: Math.min(...ms.map((m) => m.s)), end: Math.max(...ms.map((m) => m.e)) }
}
function manualResult(p) {
  const list = pickedList(p)
  const picks = list.map(({ course, opt }) => ({ courseId: course.id, code: course.code, title: course.title + (isSplit(course) ? ` (${roleOf(opt)})` : ''), credits: isSplit(course) && roleOf(opt) === 'lab' ? 0 : course.credits, part: isSplit(course) ? roleOf(opt) : null, optionId: opt.id, slot: opt.slot, faculty: opt.faculty, venue: opt.venue, star: !!opt.star }))
  return { picks, stars: picks.filter((x) => x.star).length, rank: 0, skipped: [], ...statsOf(picks) }
}

function clashBadge(reasons) {
  if (!reasons.length) return ''
  return reasons.map((r) => r.type === 'time'
    ? `<span class="pill bad" title="Class times overlap">clashes with ${esc(r.code)} ${esc(r.slot)}</span>`
    : `<span class="pill warn" title="Theory and lab of one course must be in opposite halves of the day">same half as ${esc(r.code)} ${esc(r.slot)}</span>`).join(' ')
}

function manualCard(p) {
  const list = pickedList(p)
  if (!list.length) return ''
  const r = manualResult(p)
  // Cells: mark any slot whose class time overlaps another picked section.
  const cells = new Map()
  let clashes = 0
  for (const x of list) for (const tok of x.opt.slot.split('+').map((t) => t.trim()).filter(Boolean)) {
    const tm = SLOT_MAP[tok] || []
    const hit = list.some((y) => y !== x && meetingsClash(tm, optionMeetings(y.opt)))
    const label = `${tok}-${x.course.code}${x.opt.venue ? `-${x.opt.venue}` : ''}`
    const prev = cells.get(tok)
    cells.set(tok, { label: prev ? `${prev.label} / ${label}` : label, cls: `${/^L\d/.test(tok) ? 'g-lab' : ''} ${hit || prev ? 'g-clash' : ''}` })
  }
  const pairIssues = new Set()
  for (const x of list) {
    const rs = clashReasons(x.course, x.opt, list)
    if (rs.some((r) => r.type === 'time')) clashes++
    if (rs.some((r) => r.type === 'pair')) {
      pairIssues.add(String(x.course.code || '').replace(/[LPEN]$/, ''))
      for (const tok of x.opt.slot.split('+').map((t) => t.trim()).filter(Boolean)) { const c = cells.get(tok); if (c && !c.cls.includes('g-clash')) c.cls += ' g-pair' }
    }
  }
  const missing = p.courses.filter((c) => !c.pick && !c.pickLab).map((c) => c.code || c.title)
  return `<div class="card ffcs-result" data-result="m" id="manual-tt">
    <div class="card-head"><div><h2>Picked by hand</h2><div class="small muted">${statsLine(r)}</div>
      ${clashes ? `<div class="small" style="color:var(--bad);font-weight:600">${clashes} section${clashes === 1 ? '' : 's'} with overlapping class times (dark red cells).</div>` : ''}
      ${pairIssues.size ? `<div class="small" style="color:var(--warn);font-weight:600">Theory and lab in the same half of the day for ${[...pairIssues].map(esc).join(', ')} (orange outline). Morning theory needs an evening lab, and the reverse.</div>` : ''}
      ${!clashes && !pairIssues.size ? '<div class="small" style="color:var(--good);font-weight:600">No clashes</div>' : ''}
      ${missing.length ? `<div class="small muted">Not picked yet: ${missing.map(esc).join(', ')}</div>` : ''}</div>
      <div class="row">${resultActions('m')}<button class="sm ghost no-print" data-action="b-clear-picks">Clear picks</button></div></div>
    ${gridHtml(cells)}
    <div style="margin-top:12px">${picksTable(r)}</div>
  </div>`
}

function clashCheckCard(p) {
  if (p.courses.length < 2) return ''
  const rows = clashMatrix(p.courses).filter((r) => r.ok < r.total)
  return `<div class="card"><h2 style="margin-bottom:4px">Clash check</h2>
    <p class="small muted" style="margin:0 0 10px">How many section combinations of each pair of subjects fit together (by class times${p.courses.length ? ', and the theory/lab halves rule' : ''}).</p>
    ${rows.length ? rows.slice(0, 10).map((r) => `<div class="found-item" style="margin-bottom:6px"><span class="small"><b class="mono">${esc(r.a)}</b> + <b class="mono">${esc(r.b)}</b>${r.same ? ' <span class="muted">(theory/lab pair)</span>' : ''}</span>
      <span class="pill ${r.ok === 0 ? 'bad' : r.ok / r.total < 0.34 ? 'warn' : 'accent'}">${r.ok === 0 ? 'always clash' : `${r.ok} of ${r.total} fit`}</span></div>`).join('') + (rows.length > 10 ? `<p class="small muted">${rows.length - 10} more pairs with some clashes.</p>` : '')
    : '<p class="small" style="color:var(--good);margin:0">No two subjects clash in any combination.</p>'}
  </div>`
}

// Repo-style "Subjects and Faculties" report: every section with what it clashes with.
function reportCard(p) {
  const all = p.courses.flatMap((c) => c.options.filter((o) => !o.off).map((o) => ({ course: c, opt: o })))
  let n = 0
  return `<div class="card ffcs-result" data-result="report" id="subjects-report">
    <div class="card-head"><div><h2>Subjects and faculty report</h2><div class="small muted">Generated ${new Date().toLocaleString()} · ${all.length} sections across ${p.courses.length} subjects</div></div>
      <div class="row no-print"><button class="sm" data-action="b-print-report">Print / PDF</button><button class="sm ghost" data-action="b-report-csv">CSV</button><button class="sm ghost" data-action="b-report">Close</button></div></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Course</th><th>Faculty</th><th>Slot</th><th>Venue</th><th>Clashes with</th></tr></thead><tbody>
      ${all.map(({ course, opt }) => {
        const others = all.filter((x) => x.course !== course)
        const reasons = clashReasons(course, opt, others)
        return `<tr><td class="small muted">${++n}</td><td><b class="mono small">${esc(course.code)}</b> <span class="small">${esc(course.title)}</span></td><td class="small">${esc(opt.faculty)}</td><td class="mono small">${esc(opt.slot)}</td><td class="small muted">${esc(opt.venue)}</td>
          <td class="small" style="color:var(--bad)">${reasons.slice(0, 6).map((r) => `${esc(r.faculty || '?')} (${esc(r.code)} ${esc(r.slot)}${r.type === 'pair' ? ', same half' : ''})`).join(', ')}${reasons.length > 6 ? ` and ${reasons.length - 6} more` : ''}</td></tr>`
      }).join('')}
    </tbody></table></div>
  </div>`
}

// ---------- views ----------
function courseCard(c, i, picked) {
  const on = c.options.filter((o) => !o.off).length
  const split = isSplit(c)
  return `<div class="card ffcs-course">
    <div class="card-head" style="margin-bottom:10px"><div><strong class="mono">${esc(c.code || 'Untitled')}</strong> ${esc(c.title)}
      <div class="small muted">${c.options.length} section${c.options.length === 1 ? '' : 's'} · ${on} switched on${c.category ? ` · ${esc(c.category)}` : ''} · top of the list = first choice</div></div>
      <div class="row">
        <label class="small muted" style="display:flex;gap:6px;align-items:center">Credits <input data-bcredits="${i}" type="number" min="0" max="30" step="0.5" value="${esc(c.credits ?? '')}" style="width:70px"></label>
        <button class="sm ghost" data-action="b-all" data-i="${i}" data-v="on">All on</button><button class="sm ghost" data-action="b-all" data-i="${i}" data-v="off">All off</button>
        <button class="sm ghost danger" data-action="b-remove" data-i="${i}">Remove</button>
      </div></div>
    ${c.options.length ? `<div class="table-wrap"><table class="ffcs-opts"><thead><tr><th></th><th>#</th><th title="Pick this section by hand">Pick</th><th>Slot</th><th>Faculty</th><th>Venue</th><th>Priority</th><th>Clashes</th><th></th></tr></thead><tbody>
      ${c.options.map((o, j) => `<tr class="${o.off ? 'superseded' : ''}">
        <td><input type="checkbox" data-bopt="${i}:${j}" ${o.off ? '' : 'checked'} aria-label="Use this section"></td>
        <td class="small muted">${j + 1}</td>
        <td><input type="radio" name="pick-${i}-${split ? roleOf(o) : 'one'}" data-bpick="${i}:${j}" ${c.pick === o.id || c.pickLab === o.id ? 'checked' : ''} aria-label="Pick ${esc(o.slot)}"></td>
        <td class="mono small">${esc(o.slot)}${isValidSlot(o.slot) ? '' : ' <span class="pill bad">unknown slot</span>'}</td>
        <td class="small">${esc(o.faculty)}</td><td class="small muted">${esc(o.venue)}</td>
        <td><div class="row" style="flex-wrap:nowrap;gap:4px">
          <button class="sm ghost" data-action="b-move" data-i="${i}" data-j="${j}" data-v="-1" ${j ? '' : 'disabled'} aria-label="Move up">Up</button>
          <button class="sm ghost" data-action="b-move" data-i="${i}" data-j="${j}" data-v="1" ${j < c.options.length - 1 ? '' : 'disabled'} aria-label="Move down">Down</button>
          <button class="sm ${o.star ? 'primary' : 'ghost'}" data-action="b-star" data-i="${i}" data-j="${j}" aria-pressed="${!!o.star}">${o.star ? 'Preferred' : 'Prefer'}</button></div></td>
        <td>${picked.length ? clashBadge(clashReasons(c, o, picked)) || '<span class="pill good">fits</span>' : '<span class="small muted">-</span>'}</td>
        <td><button class="sm ghost" data-action="b-del-opt" data-i="${i}" data-j="${j}">Delete</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="small muted" style="margin:0 0 8px">No sections yet. Add the slot and faculty below.</p>'}
    <form class="row" data-form="b-add-opt" data-i="${i}" style="margin-top:10px">
      <input name="slot" placeholder="Slot, e.g. B1+TB1 or L31+L32" required style="width:200px">
      <input name="faculty" placeholder="Faculty" style="flex:1;min-width:120px">
      <input name="venue" placeholder="Venue" style="width:110px">
      <button type="submit" class="sm">Add section</button>
    </form>
  </div>`
}

function statsLine(r) {
  const credits = r.picks.reduce((a, p) => a + (Number(p.credits) || 0), 0)
  const timing = Number.isFinite(r.start) && Number.isFinite(r.end) ? ` · ${hm(r.start)} to ${hm(r.end)}` : ''
  return `${r.days} day${r.days === 1 ? '' : 's'} a week${timing} · ${Math.round((r.gaps || 0) / 6) / 10} h gaps${r.labDays !== undefined ? ` · ${r.labDays} lab day${r.labDays === 1 ? '' : 's'}` : ''}${r.stars ? ` · ${r.stars} preferred` : ''}${credits ? ` · ${credits} credits` : ''}`
}

function picksTable(r) {
  return `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Slot</th><th>Faculty</th><th>Venue</th></tr></thead><tbody>
    ${r.picks.map((p) => `<tr><td><strong class="mono small">${esc(p.code)}</strong> <span class="small">${esc(p.title)}</span></td><td class="mono small">${esc(p.slot)}</td><td class="small">${esc(p.faculty)}${p.star ? ' <span class="pill accent">preferred</span>' : ''}</td><td class="small muted">${esc(p.venue)}</td></tr>`).join('')}
  </tbody></table></div>`
}

function resultActions(ref) {
  return `<div class="row no-print">
    <button class="sm" data-action="b-save" data-ref="${ref}">Save</button>
    <button class="sm ghost" data-action="b-print" data-ref="${ref}">Print / PDF</button>
    <button class="sm ghost" data-action="b-csv" data-ref="${ref}">CSV</button>
    ${ref !== 'm' ? `<button class="sm ghost" data-action="b-edit" data-ref="${ref}">Edit by hand</button>` : ''}
    <button class="sm primary" data-action="b-use" data-ref="${ref}">Use for upcoming semester</button></div>`
}

function resultCard(r, n, ref) {
  return `<div class="card ffcs-result" data-result="${ref}">
    <div class="card-head"><div><h3>Option ${n}</h3><div class="small muted">${statsLine(r)}</div>
      ${r.skipped?.length ? `<div class="small" style="color:var(--warn)">Leaves out: ${r.skipped.map(esc).join(', ')}</div>` : ''}</div>${resultActions(ref)}</div>
    ${gridHtml(resultCells(r))}
    <div style="margin-top:12px">${picksTable(r)}</div>
  </div>`
}

function groupCard(variants, n, gi) {
  const first = variants[0]
  const key = (p) => `${p.code}|${p.part || ''}`
  const facultyByCourse = {}
  for (const v of variants) for (const p of v.picks) (facultyByCourse[key(p)] = facultyByCourse[key(p)] || new Set()).add(p.faculty)
  return `<div class="card ffcs-result" data-result="g${gi}:0">
    <div class="card-head"><div><h3>Layout ${n}</h3><div class="small muted">${variants.length} faculty combination${variants.length === 1 ? '' : 's'} with these slots · ${statsLine(first)}</div></div></div>
    ${gridHtml(resultCells(first))}
    <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Course</th><th>Slot</th><th>Faculty options</th></tr></thead><tbody>
      ${first.picks.map((p) => `<tr><td><strong class="mono small">${esc(p.code)}</strong> <span class="small">${esc(p.title)}</span></td><td class="mono small">${esc(p.slot)}</td><td class="small">${[...facultyByCourse[key(p)]].map(esc).join(', ')}</td></tr>`).join('')}
    </tbody></table></div>
    <details style="margin-top:10px"><summary class="small" style="cursor:pointer;font-weight:600">Choose a faculty combination</summary>
      ${variants.slice(0, 30).map((v) => `<div class="found-item" style="margin-top:6px;flex-wrap:wrap"><span class="small">${v.picks.map((p) => `${esc(p.code)}: ${esc(p.faculty)}`).join(' · ')}</span>${resultActions(`g${gi}:${v._vi}`)}</div>`).join('')}
      ${variants.length > 30 ? `<p class="small muted">${variants.length - 30} more combinations.</p>` : ''}
    </details>
  </div>`
}

function catalogList(matches, p) {
  if (!matches.length) return '<p class="small muted" style="margin:0">No courses match.</p>'
  return matches.slice(0, 40).map((c) => {
    const added = p.courses.some((x) => x.code === c.code)
    return `<div class="found-item" style="margin-bottom:6px"><span class="small"><b class="mono">${esc(c.code)}</b> ${esc(c.title)}<br><span class="muted">${(c.sections || []).length} sections${c.credits ? ` · ${c.credits} credits` : ''}${c.categoryLabel ? ` · ${esc(c.categoryLabel)}` : ''}</span></span>
      <button class="sm ${added ? 'ghost' : ''}" data-action="b-add-cat" data-code="${esc(c.code)}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button></div>`
  }).join('') + (matches.length > 40 ? `<p class="small muted" style="margin:6px 0 0">${matches.length - 40} more. Narrow the search.</p>` : '')
}

const matchCatalog = (d) => {
  const q = ui.search.trim().toLowerCase()
  return (d.ffcsCatalog?.courses || []).filter((c) => (!ui.category || c.category === ui.category) && (!q || c.code.toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q) || (c.sections || []).some((s) => s.faculty.toLowerCase().includes(q))))
}

// Slot View: click slots; anything whose class times overlap a picked slot is greyed out.
function pickerHtml(d) {
  const picked = ui.picker
  const pickedMeetings = picked.flatMap((s) => SLOT_MAP[s] || [])
  const disabled = new Set(Object.keys(SLOT_MAP).filter((s) => !picked.includes(s) && meetingsClash(SLOT_MAP[s], pickedMeetings)))
  const cells = new Map(picked.map((s) => [s, { label: s, cls: /^L\d/.test(s) ? 'g-lab' : '' }]))
  const sections = []
  if (picked.length) {
    const set = new Set(picked)
    for (const c of d.ffcsCatalog?.courses || []) for (const s of c.sections || []) {
      const toks = splitSlots(s.slot)
      if (toks.length && toks.every((t) => set.has(t))) sections.push({ code: c.code, title: c.title, ...s })
    }
  }
  return `<div class="card" id="slot-view">
    <div class="card-head"><div><h2>Slot View</h2><p class="small muted" style="margin:2px 0 0">Click slots to plan by hand. Slots whose class times overlap your picks are greyed out.</p></div>
      ${picked.length ? '<button class="sm ghost" data-action="b-pick-clear">Clear</button>' : ''}</div>
    ${gridHtml(cells, { clickable: true, disabled })}
    ${picked.length ? `<p class="small" style="margin:10px 0 0">Picked: <span class="mono">${picked.join(' + ')}</span></p>` : ''}
    ${picked.length && d.ffcsCatalog ? `<p class="small muted" style="margin:6px 0 0">${sections.length ? `Sections that fit entirely in these slots: ${sections.slice(0, 20).map((s) => `<b class="mono">${esc(s.code)}</b> ${esc(s.slot)} (${esc(s.faculty)})`).join(' · ')}${sections.length > 20 ? ` and ${sections.length - 20} more` : ''}` : 'No fetched sections fit entirely in these slots.'}</p>` : ''}
  </div>`
}

const getRef = (ref) => {
  if (ref === 'v') return ui.viewing
  if (ref === 'm') return null // resolved with the plan in builderClick
  if (String(ref).startsWith('g')) { const [g, k] = String(ref).slice(1).split(':').map(Number); return ui.out?.groups?.[g]?.variants?.[k] }
  return ui.out?.results?.[Number(ref)]
}

function filteredResults() {
  if (!ui.out) return null
  const q = ui.facultyFilter.trim().toLowerCase()
  const keep = (r) => !q || r.picks.some((p) => (p.faculty || '').toLowerCase().includes(q))
  if (ui.grouped) return ui.out.groups.map((g, gi) => ({ gi, variants: g.variants.map((v, vi) => Object.assign(v, { _vi: vi })).filter(keep) })).filter((x) => x.variants.length)
  return ui.out.results.map((r, i) => ({ r, i })).filter((x) => keep(x.r))
}

export function viewBuilder(d) {
  const p = plan(d)
  const cat = d.ffcsCatalog
  const st = studentLine(d)
  const totalCredits = p.courses.reduce((a, c) => a + (Number(c.credits) || 0), 0)
  const maxCredits = Number(d.plan?.maxPerSem) || 27.5
  const existing = existingCourses(d).filter((c) => !p.courses.some((x) => x.code === c.code))
  const categories = [...new Map((cat?.courses || []).map((c) => [c.category, c.categoryLabel || c.category])).entries()]
  const list = filteredResults()
  const pages = list ? Math.ceil(list.length / PER_PAGE) : 0
  const sel = (name, options, value) => `<select data-bset="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(value ?? '') === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`
  const out = ui.out

  return `
  <div class="page-head"><div><h1>Timetable Builder</h1>
    <p class="muted">${st.reg ? `${esc(st.reg)}${st.batch ? ` · batch ${st.batch}` : ''}${st.year ? ` · year ${st.year}` : ''} · ` : ''}Planning ${esc(st.cal.upcoming.label)}. Pick subjects and faculty, then generate every clash-free timetable.</p></div></div>

  <div class="grid cols-3-1">
    <div class="stack">
      <div class="card">
        <div class="card-head"><div><h2>Course allocation from VTOP</h2>
          <p class="small muted" style="margin:2px 0 0">${cat ? `${cat.courses.length} courses for ${esc(cat.term?.text || 'the semester')} · fetched ${new Date(cat.fetchedAt).toLocaleString()}` : 'Every course offered to you, with its slots, faculty and venues.'}</p></div>
          ${ext.version ? `<button class="${cat ? '' : 'primary'}" data-action="b-fetch" ${ui.fetching ? 'disabled' : ''}>${ui.fetching ? 'Fetching…' : cat ? 'Fetch again' : 'Fetch from VTOP'}</button>` : '<a class="btn" href="#/import">Set up the extension</a>'}</div>
        ${ui.fetching ? `<p class="small muted" data-bprogress>${esc(ui.progress)}</p>` : ''}
        ${ui.fetchError ? `<div class="notice warn">${esc(ui.fetchError)}</div>` : ''}
        ${cat ? `<div class="row" style="margin-bottom:10px">
            <input data-bsearch value="${esc(ui.search)}" placeholder="Search code, course or faculty" style="flex:1;min-width:160px">
            ${categories.length > 1 ? `<select data-bcat><option value="">All categories</option>${categories.map(([k, l]) => `<option value="${esc(k)}" ${ui.category === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
          </div>
          <div class="ffcs-catalog" data-bresults>${catalogList(matchCatalog(d), p)}</div>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><h2>Your subjects</h2><div class="row"><span class="pill ${totalCredits > maxCredits ? 'bad' : 'accent'}">${totalCredits} of ${maxCredits} credits</span>${p.courses.length ? '<button class="sm ghost" data-action="b-report">Subjects report</button>' : ''}</div></div>
        <p class="small muted" style="margin:0 0 10px">Use the Pick column to build a timetable by hand: every other section shows what it would clash with.</p>
        ${totalCredits > maxCredits ? `<div class="notice warn" style="margin-bottom:12px">That's over the ${maxCredits}-credit limit per semester (unless you have extra NPTEL / open elective credits).</div>` : ''}
        ${existing.length ? `<div class="row" style="margin-bottom:12px"><select data-bexisting style="flex:1;min-width:180px"><option value="">Add from your courses (timetables)…</option>${existing.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} - ${esc(c.title)}${c.options.length ? ` (${c.options.length} section${c.options.length > 1 ? 's' : ''})` : ''}</option>`).join('')}</select></div>` : ''}
        <form class="row" data-form="b-add-course">
          <input name="code" placeholder="Code, e.g. BCSE302L" style="width:150px">
          <input name="title" placeholder="New subject name" style="flex:1;min-width:140px">
          <input name="credits" type="number" min="0" max="30" step="0.5" placeholder="Credits" style="width:90px">
          <button type="submit" class="primary">Add subject</button>
        </form>
      </div>

      ${(() => { const picked = pickedList(p); return p.courses.map((c, i) => courseCard(c, i, picked)).join('') })()}
    </div>

    <div class="stack">
      <div class="card">
        <h2 style="margin-bottom:10px">Generate</h2>
        <div class="daytabs" style="margin-bottom:12px">${[['mixed', 'Mixed'], ['morning', 'Morning theory'], ['afternoon', 'Evening theory']].map(([k, l]) => `<button data-action="b-filter" data-v="${k}" class="${p.filter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="form" style="gap:10px">
          <label class="field">First class no earlier than ${sel('earliest', [['', 'Any time'], [540, '09:00'], [600, '10:00'], [660, '11:00'], [840, '14:00']], p.earliest)}</label>
          <label class="field">Last class ends by ${sel('latest', [['', 'Any time'], [800, '13:20'], [1020, '17:00'], [1080, '18:00'], [1110, '18:30'], [1140, '19:00']], p.latest)}</label>
          <label class="field">Most lab days a week ${sel('maxLabDays', [['', 'Any'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], p.maxLabDays)}</label>
          <label class="field">Keep this day free ${sel('dayOff', [['', 'No preference'], ['MON', 'Monday'], ['TUE', 'Tuesday'], ['WED', 'Wednesday'], ['THU', 'Thursday'], ['FRI', 'Friday']], p.dayOff)}</label>
          <label class="field">Avoid faculty <input data-bavoid value="${esc(p.avoidFaculty || '')}" placeholder="Names, separated by commas"></label>
          <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-bflag="freeDay" ${p.freeDay ? 'checked' : ''}> At least one free weekday</label>
          <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-bflag="avoidWeekend" ${p.avoidWeekend ? 'checked' : ''}> No Saturday or Sunday slots</label>
          <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-bflag="sameBuilding" ${p.sameBuilding ? 'checked' : ''}> All classes in one building</label>
          <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-bflag="sameFaculty" ${p.sameFaculty ? 'checked' : ''}> Same faculty for theory and lab</label>
        </div>
        <button class="primary" data-action="b-generate" ${p.courses.length ? '' : 'disabled'} style="width:100%;justify-content:center;margin-top:14px">Generate timetables</button>
        <p class="small muted" style="margin:10px 0 0">Theory and lab of a course are always in opposite halves: morning theory (before 13:20) with an evening lab (14:00 or later), or the reverse. Clashes are checked on actual class times. Ranking: preferred faculty, then your priority order, then fewer days and gaps.</p>
      </div>
      ${clashCheckCard(p)}
      ${p.saved.length ? `<div class="card"><h2 style="margin-bottom:10px">Saved timetables</h2>
        ${p.saved.map((s, i) => `<div class="found-item" style="margin-bottom:8px;flex-wrap:wrap"><span class="small"><input data-bsavename="${i}" value="${esc(s.name)}" aria-label="Timetable name" style="font-weight:600;padding:4px 8px;width:160px"><br><span class="muted">${s.picks.length} subjects · ${new Date(s.savedAt).toLocaleDateString()}</span>
            ${s.shareId ? `<br><a href="#/share/${esc(s.shareId)}" class="small">Shared link</a>` : ''}</span>
          <span class="row"><button class="sm" data-action="b-view" data-i="${i}">View</button>
            <button class="sm ghost" data-action="b-share" data-i="${i}">${s.shareId ? 'Copy link' : 'Share'}</button>
            ${s.shareId ? `<button class="sm ghost" data-action="b-unshare" data-i="${i}">Stop sharing</button>` : ''}
            <button class="sm ghost" data-action="b-unsave" data-i="${i}">Delete</button></span></div>`).join('')}</div>` : ''}
    </div>
  </div>

  ${ui.report ? reportCard(p) : ''}
  ${manualCard(p)}
  ${pickerHtml(d)}

  ${ui.viewing ? `<div id="ffcs-results"><div class="page-head" style="margin-top:8px"><div><h2>Saved: ${esc(ui.viewing.name)}</h2></div><button class="sm ghost" data-action="b-close-view">Close</button></div>
    ${resultCard(ui.viewing, 1, 'v')}</div>`
  : out ? `<div id="ffcs-results">
    <div class="page-head" style="margin-top:8px"><div>
      <h2>${out.results.length}${out.truncated ? '+' : ''} timetable${out.results.length === 1 ? '' : 's'}${out.groups.length && out.groups.length !== out.results.length ? ` in ${out.groups.length} slot layout${out.groups.length === 1 ? '' : 's'}` : ''}</h2>
      ${out.partial ? `<div class="notice warn" style="margin-top:8px">No timetable fits all ${out.partial.total} subjects. These fit ${out.partial.fitted} of ${out.partial.total}; each option says what it leaves out.</div>` : ''}
      ${out.problems.length ? `<div class="notice bad" style="margin-top:8px">${out.problems.map(esc).join('<br>')}</div>` : ''}</div>
      ${out.results.length ? `<div class="row">
        <input data-bfacfilter value="${esc(ui.facultyFilter)}" placeholder="Must include faculty…" style="width:180px">
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-bgroup ${ui.grouped ? 'checked' : ''}> Group by slots</label>
        ${pages > 1 ? `<button class="sm" data-action="b-page" data-v="-1" ${ui.page ? '' : 'disabled'}>Previous</button><span class="small muted">Page ${ui.page + 1} of ${pages}</span><button class="sm" data-action="b-page" data-v="1" ${ui.page + 1 < pages ? '' : 'disabled'}>Next</button>` : ''}
      </div>` : ''}</div>
    ${list.length ? list.slice(ui.page * PER_PAGE, ui.page * PER_PAGE + PER_PAGE).map((x, k) => (ui.grouped
      ? groupCard(x.variants, ui.page * PER_PAGE + k + 1, x.gi)
      : resultCard(x.r, ui.page * PER_PAGE + k + 1, x.i))).join('') : out.results.length ? '<p class="muted">No timetable includes that faculty.</p>' : ''}
  </div>` : ''}`
}

// ---------- actions (ctx: { state, save, saveSoon, render, toast, api }) ----------
function csvOf(r) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return ['Course code,Course,Credits,Slot,Faculty,Venue', ...r.picks.map((p) => [p.code, p.title, p.credits, p.slot, p.faculty, p.venue].map(q).join(','))].join('\n')
}
function download(name, text, type) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name })
  link.click(); URL.revokeObjectURL(link.href)
}

export async function builderClick(a, el, ctx) {
  const d = ctx.state.data
  const p = plan(d)
  const course = (i) => p.courses[+i]
  const changed = () => { ui.out = null; ui.viewing = null; ctx.saveSoon('ffcs'); ctx.render() }
  switch (a) {
    case 'b-fetch': return fetchAllocation(ctx)
    case 'b-add-cat': {
      const c = (d.ffcsCatalog?.courses || []).find((x) => x.code === el.dataset.code)
      if (!c || p.courses.some((x) => x.code === c.code)) return true
      p.courses.push({ id: c.code, code: c.code, title: c.title, credits: c.credits ?? '', category: c.categoryLabel || c.category, options: (c.sections || []).map((s) => ({ ...s, id: optId(s) })) })
      changed(); return true
    }
    case 'b-remove': p.courses.splice(+el.dataset.i, 1); changed(); return true
    case 'b-all': course(el.dataset.i).options.forEach((o) => (o.off = el.dataset.v === 'off')); changed(); return true
    case 'b-star': { const o = course(el.dataset.i).options[+el.dataset.j]; o.star = !o.star; changed(); return true }
    case 'b-move': {
      const opts = course(el.dataset.i).options, j = +el.dataset.j, k = j + Number(el.dataset.v)
      if (k < 0 || k >= opts.length) return true
      ;[opts[j], opts[k]] = [opts[k], opts[j]]
      changed(); return true
    }
    case 'b-del-opt': course(el.dataset.i).options.splice(+el.dataset.j, 1); changed(); return true
    case 'b-filter': p.filter = el.dataset.v; changed(); return true
    case 'b-generate': {
      const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v))
      ui.out = generate(p.courses, { filter: p.filter, avoidWeekend: p.avoidWeekend, sameFaculty: p.sameFaculty, earliest: num(p.earliest), latest: num(p.latest), freeDay: p.freeDay, maxLabDays: num(p.maxLabDays), sameBuilding: p.sameBuilding, dayOff: p.dayOff || '', avoidFaculty: String(p.avoidFaculty || '').split(',') })
      Object.assign(ui, { page: 0, viewing: null })
      ctx.render(); document.getElementById('ffcs-results')?.scrollIntoView({ behavior: 'smooth' }); return true
    }
    case 'b-page': ui.page = Math.max(0, ui.page + Number(el.dataset.v)); ctx.render(); document.getElementById('ffcs-results')?.scrollIntoView(); return true
    case 'b-save': {
      const r = el.dataset.ref === 'm' ? manualResult(p) : getRef(el.dataset.ref)
      if (!r) return true
      p.saved.unshift({ name: `Timetable ${p.saved.length + 1}`, savedAt: Date.now(), picks: r.picks, stars: r.stars, days: r.days, gaps: r.gaps, start: r.start, end: r.end, labDays: r.labDays, rank: r.rank, skipped: r.skipped || [] })
      ctx.saveSoon('ffcs'); ctx.toast('Saved to your account'); ctx.render(); return true
    }
    case 'b-view': ui.viewing = { ...p.saved[+el.dataset.i] }; ctx.render(); document.getElementById('ffcs-results')?.scrollIntoView({ behavior: 'smooth' }); return true
    case 'b-close-view': ui.viewing = null; ctx.render(); return true
    case 'b-unsave': {
      const s = p.saved[+el.dataset.i]
      if (s?.shareId) await ctx.api('DELETE', `/api/share/${s.shareId}`).catch(() => {})
      p.saved.splice(+el.dataset.i, 1); ctx.saveSoon('ffcs'); ctx.render(); return true
    }
    case 'b-share': {
      const s = p.saved[+el.dataset.i]
      if (!s.shareId) {
        try { s.shareId = (await ctx.api('POST', '/api/share', { title: s.name, data: { picks: s.picks, stats: { days: s.days, gaps: s.gaps, start: s.start, end: s.end, labDays: s.labDays }, semester: calendarSemesters().upcoming.label } })).id }
        catch (e) { ctx.toast(e.message); return true }
        ctx.saveSoon('ffcs')
      }
      const url = `${location.origin}/#/share/${s.shareId}`
      try { await navigator.clipboard.writeText(url); ctx.toast('Link copied. Anyone with it can view this timetable.') } catch { ctx.toast(url) }
      ctx.render(); return true
    }
    case 'b-unshare': {
      const s = p.saved[+el.dataset.i]
      await ctx.api('DELETE', `/api/share/${s.shareId}`).catch(() => {})
      delete s.shareId; ctx.saveSoon('ffcs'); ctx.toast('Link removed'); ctx.render(); return true
    }
    case 'b-print': {
      const card = el.closest('[data-result]')
      if (!card) return true
      card.classList.add('print-target'); document.body.classList.add('printing')
      setTimeout(() => { window.print(); card.classList.remove('print-target'); document.body.classList.remove('printing') }, 50)
      return true
    }
    case 'b-csv': { const r = el.dataset.ref === 'm' ? manualResult(p) : getRef(el.dataset.ref); if (r) download('timetable.csv', csvOf(r), 'text/csv'); return true }
    case 'b-clear-picks': p.courses.forEach((c) => { delete c.pick; delete c.pickLab }); ctx.saveSoon('ffcs'); ctx.render(); return true
    case 'b-edit': {
      const r = getRef(el.dataset.ref)
      if (!r) return true
      p.courses.forEach((c) => { delete c.pick; delete c.pickLab })
      for (const x of r.picks) {
        const c = p.courses.find((cc) => cc.id === x.courseId || cc.code === x.code)
        const o = c?.options.find((oo) => oo.id === x.optionId)
        if (!o) continue
        if (isSplit(c) && roleOf(o) === 'lab') c.pickLab = o.id; else c.pick = o.id
      }
      ctx.saveSoon('ffcs'); ctx.render(); document.getElementById('manual-tt')?.scrollIntoView({ behavior: 'smooth' }); return true
    }
    case 'b-report': ui.report = !ui.report; ctx.render(); if (ui.report) document.getElementById('subjects-report')?.scrollIntoView({ behavior: 'smooth' }); return true
    case 'b-print-report': { const card = document.getElementById('subjects-report'); card.classList.add('print-target'); document.body.classList.add('printing'); setTimeout(() => { window.print(); card.classList.remove('print-target'); document.body.classList.remove('printing') }, 50); return true }
    case 'b-report-csv': {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const all = p.courses.flatMap((c) => c.options.filter((o) => !o.off).map((o) => ({ course: c, opt: o })))
      const rows = all.map(({ course, opt }) => [course.code, course.title, opt.faculty, opt.slot, opt.venue, clashReasons(course, opt, all.filter((x) => x.course !== course)).map((r) => `${r.faculty} (${r.code} ${r.slot})`).join('; ')].map(q).join(','))
      download('subjects-report.csv', ['Course code,Course,Faculty,Slot,Venue,Clashes with', ...rows].join('\n'), 'text/csv'); return true
    }
    case 'b-pick': {
      const s = el.dataset.slot
      ui.picker = ui.picker.includes(s) ? ui.picker.filter((x) => x !== s) : [...ui.picker, s]
      const box = document.getElementById('slot-view')
      if (box) box.outerHTML = pickerHtml(d)
      return true
    }
    case 'b-pick-clear': ui.picker = []; document.getElementById('slot-view').outerHTML = pickerHtml(d); return true
    case 'b-use': {
      const r = el.dataset.ref === 'm' ? manualResult(p) : getRef(el.dataset.ref)
      if (!r) return true
      const prev = Object.fromEntries((d.upcoming || []).map((c) => [c.code, c]))
      // A course picked as separate theory + lab sections becomes one row (slots joined).
      const merged = new Map()
      for (const x of r.picks) {
        const m = merged.get(x.code)
        if (m) { m.slot += '+' + x.slot; if (x.venue && !m.venue.includes(x.venue)) m.venue += ', ' + x.venue; m.credits = Math.max(Number(m.credits) || 0, Number(x.credits) || 0) || '' }
        else merged.set(x.code, { code: x.code, title: String(x.title).replace(/ \((theory|lab)\)$/, ''), credits: Number(x.credits) || '', slot: x.slot, faculty: x.faculty, venue: x.venue || '', manual: false, expected: prev[x.code]?.expected || '' })
      }
      await ctx.save('upcoming', [...merged.values()])
      ctx.toast('Set as your upcoming semester. Open the GPA calculator to add expected grades.')
      return true
    }
  }
  return false
}

export function builderInput(el, ctx) {
  const d = ctx.state.data
  const p = plan(d)
  if (el.matches('[data-bsearch]')) {
    ui.search = el.value
    const box = document.querySelector('[data-bresults]')
    if (box) box.innerHTML = catalogList(matchCatalog(d), p)
    return true
  }
  if (el.matches('[data-bfacfilter]')) {
    ui.facultyFilter = el.value; ui.page = 0
    const pos = el.selectionStart
    ctx.render()
    const again = document.querySelector('[data-bfacfilter]')
    if (again) { again.focus(); again.setSelectionRange(pos, pos) }
    return true
  }
  if (el.matches('[data-bavoid]')) { p.avoidFaculty = el.value; ui.out = null; ctx.saveSoon('ffcs'); return true }
  if (el.matches('[data-bcredits]')) { p.courses[+el.dataset.bcredits].credits = el.value === '' ? '' : Number(el.value); ctx.saveSoon('ffcs'); return true }
  return false
}

export function builderChange(el, ctx) {
  const d = ctx.state.data
  const p = plan(d)
  if (el.matches('[data-bcat]')) { ui.category = el.value; ctx.render(); return true }
  if (el.matches('[data-bpick]')) {
    const [i, j] = el.dataset.bpick.split(':').map(Number)
    const c = p.courses[i], o = c.options[j]
    if (isSplit(c) && roleOf(o) === 'lab') c.pickLab = o.id; else c.pick = o.id
    ctx.saveSoon('ffcs'); ctx.render(); return true
  }
  if (el.matches('[data-bsavename]')) { const s = p.saved[+el.dataset.bsavename]; if (s) { s.name = el.value.trim().slice(0, 60) || s.name; ctx.saveSoon('ffcs') } return true }
  if (el.matches('[data-bgroup]')) { ui.grouped = el.checked; ui.page = 0; ctx.render(); return true }
  if (el.matches('[data-bset]')) { p[el.dataset.bset] = el.value; ui.out = null; ctx.saveSoon('ffcs'); ctx.render(); return true }
  if (el.matches('[data-bopt]')) {
    const [i, j] = el.dataset.bopt.split(':').map(Number)
    p.courses[i].options[j].off = !el.checked
    ui.out = null; ctx.saveSoon('ffcs'); ctx.render(); return true
  }
  if (el.matches('[data-bflag]')) { p[el.dataset.bflag] = el.checked; ui.out = null; ctx.saveSoon('ffcs'); ctx.render(); return true }
  if (el.matches('[data-bexisting]')) {
    const c = existingCourses(d).find((x) => x.code === el.value)
    if (c && !p.courses.some((x) => x.code === c.code)) {
      p.courses.push({ id: c.code, code: c.code, title: c.title, credits: c.credits ?? '', options: c.options.map((o) => ({ ...o, id: optId(o) })) })
      ui.out = null; ctx.saveSoon('ffcs')
    }
    ctx.render(); return true
  }
  return false
}

export function builderSubmit(kind, form, f, ctx) {
  const d = ctx.state.data
  const p = plan(d)
  if (kind === 'b-add-course') {
    const code = String(f.code || '').trim().toUpperCase()
    const title = String(f.title || '').trim()
    if (!code && !title) { ctx.toast('Enter a code or a subject name'); return true }
    if (code && p.courses.some((x) => x.code === code)) { ctx.toast(`${code} is already in your list`); return true }
    p.courses.push({ id: code || `m${Date.now()}`, code, title, credits: f.credits === '' ? '' : Number(f.credits), options: [] })
    ui.out = null; ctx.saveSoon('ffcs'); ctx.render()
    const forms = document.querySelectorAll('[data-form=b-add-opt] [name=slot]'); forms[forms.length - 1]?.focus()
    return true
  }
  if (kind === 'b-add-opt') {
    const c = p.courses[+form.dataset.i]
    const slot = normSlot(f.slot)
    if (!isValidSlot(slot)) { ctx.toast(`"${f.slot}" isn't a VIT slot. Use names like A1, TB1, L31, joined with +`); return true }
    const o = { slot, faculty: String(f.faculty || '').trim(), venue: String(f.venue || '').trim() }
    c.options.push({ ...o, id: optId(o) })
    ui.out = null; ctx.saveSoon('ffcs'); ctx.render(); return true
  }
  return false
}

// Read-only page for a shared link (works without logging in).
export function viewShared(share) {
  if (!share) return '<main><div class="boot">Loading…</div></main>'
  if (share.error) return `<main><div class="card empty"><h2>Link not found</h2><p>${esc(share.error)}</p><a class="btn" href="#/">Open the dashboard</a></div></main>`
  const r = { picks: share.data.picks, ...(share.data.stats || {}) }
  const meetings = r.picks.flatMap((p) => slotMeetings(p.slot).meetings)
  return `<main>
    <div class="page-head"><div><h1>${esc(share.title || 'Shared timetable')}</h1><p class="muted">${share.data.semester ? `${esc(share.data.semester)} · ` : ''}${r.picks.length} subjects · shared ${new Date(share.created_at).toLocaleDateString()}${meetings.length ? ` · ${hm(Math.min(...meetings.map((m) => m.s)))} to ${hm(Math.max(...meetings.map((m) => m.e)))}` : ''}</p></div>
      <div class="row no-print"><button class="sm ghost" data-action="print-page">Print / PDF</button><a class="btn sm" href="#/">Open the dashboard</a></div></div>
    <div class="card">${gridHtml(resultCells(r))}<div style="margin-top:12px">${picksTable(r)}</div></div>
  </main>`
}

async function fetchAllocation(ctx) {
  const d = ctx.state.data
  const cal = calendarSemesters()
  Object.assign(ui, { fetching: true, progress: 'Starting…', fetchError: '' })
  ctx.render()
  const res = await requestAllocation(vtopName(cal.upcoming.label).toLowerCase(), (t) => {
    ui.progress = t
    const el = document.querySelector('[data-bprogress]')
    if (el) el.textContent = t
  })
  ui.fetching = false
  if (res?.ok) {
    await ctx.save('ffcsCatalog', { term: res.term, fetchedAt: Date.now(), categories: res.categories, courses: res.courses.map(({ code, title, category, categoryLabel, credits, sections }) => ({ code, title, category, categoryLabel, credits, sections })) })
    // Refresh sections of subjects already picked from the catalogue (keep on/off, preferred and order).
    const p = plan(d)
    for (const c of p.courses) {
      const fresh = res.courses.find((x) => x.code === c.code)
      if (!fresh) continue
      const marks = Object.fromEntries(c.options.map((o, i) => [o.id, { ...o, i }]))
      c.options = fresh.sections.map((s) => { const id = optId(s); return { ...s, id, off: marks[id]?.off, star: marks[id]?.star, _i: marks[id]?.i ?? 1e6 } })
        .sort((a, b) => a._i - b._i).map(({ _i, ...o }) => o)
    }
    ctx.saveSoon('ffcs')
    ctx.toast(`Fetched ${res.courses.length} courses`)
    if (res.errors?.length) ui.fetchError = `Some courses couldn't be read: ${res.errors.slice(0, 5).join('; ')}`
  } else {
    ui.fetchError = res?.error || 'Fetch failed'
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && res?.debug) ctx.save('debug', { when: new Date().toISOString(), allocation: true, steps: res.steps || [], ...res.debug })
  }
  ctx.render()
  return true
}
