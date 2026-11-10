// Credit Planner: how many credits of each curriculum category (Foundation Core, Discipline Core,
// electives, NGCR, ...) to take in each remaining semester.
import { planModel } from './planner.js'
import { fmt } from './calc.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const num = (v, d = 0) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? d : Number(v))
const f1 = (x) => fmt(x, Number(x) % 1 ? 1 : 0)
const half = (x) => Math.round(x * 2) / 2

// Same category under different names (curriculum vs timetable vs course allocation).
export function categoryKey(name) {
  const t = String(name || '').toLowerCase()
  if (/non.?graded|\bngcr\b/.test(t)) return 'NG'
  if (/project|internship|capstone|dissertation/.test(t)) return 'PRJ'
  if (/open elective|university elective|\boe\b|\bue\b|\buniversity\s*elective/.test(t)) return 'OE'
  if (/discipline elective|program(me)? elective|\bde\b|\bpe\b/.test(t)) return 'DE'
  if (/discipline core|program(me)? core|\bdc\b|\bpc\b/.test(t)) return 'DC'
  if (/foundation|university core|\bfc\b|\buc\b/.test(t)) return 'FC'
  if (/bridge/.test(t)) return 'BR'
  return t.replace(/[^a-z0-9]/g, '')
}
// Order to fill semesters: cores first, electives next, projects at the end.
const PRIORITY = { NG: 0, FC: 1, DC: 2, DE: 3, OE: 4, BR: 5, PRJ: 9 }

function categories(data) {
  const plan = data.plan || {}
  const base = (data.curriculum?.categories || []).map((c) => ({ name: c.name, required: num(c.required), earned: num(c.earned), custom: false }))
  const custom = (plan.customCats || []).map((c, i) => ({ name: c.name, required: num(c.required), earned: num(c.earned), custom: true, idx: i }))
  return [...base, ...custom].map((c) => ({ ...c, key: categoryKey(c.name), left: Math.max(c.required - c.earned, 0) }))
}

export function creditModel(data) {
  const pm = planModel(data)
  const cats = categories(data)
  const alloc = data.plan?.catAlloc || {}
  const sems = pm.sems.map((s) => s.label)
  const max = pm.max

  // Current semester: what you're registered for, by category.
  const current = {}
  const unmatched = []
  if (pm.registered > 0) {
    for (const c of data.current || []) {
      const cat = cats.find((x) => x.key === categoryKey(c.category || c.type || ''))
      if (cat) current[cat.name] = (current[cat.name] || 0) + num(c.credits)
      else if (num(c.credits)) unmatched.push(c)
    }
  }

  // Plan each semester: your numbers where typed, otherwise a suggestion.
  const leftAfter = Object.fromEntries(cats.map((c) => [c.name, c.left]))
  const grid = {} // grid[sem][cat] = { value, typed, registered }
  sems.forEach((sem, i) => {
    grid[sem] = {}
    const isCurrent = i === 0 && pm.registered > 0
    const typed = alloc[sem] || {}
    let used = 0
    // 1) registered (current semester) and typed numbers are fixed
    for (const c of cats) {
      let v = null
      if (isCurrent && typed[c.name] === undefined) v = current[c.name] || 0
      if (typed[c.name] !== undefined && typed[c.name] !== '') v = num(typed[c.name])
      if (v !== null) { grid[sem][c.name] = { value: v, typed: typed[c.name] !== undefined && typed[c.name] !== '', registered: isCurrent && typed[c.name] === undefined }; used += v }
    }
    if (isCurrent) {
      for (const c of cats) if (!grid[sem][c.name]) grid[sem][c.name] = { value: 0, registered: true }
    } else {
      // 2) suggestion for the rest: spread what's left over the remaining semesters, cores first, projects last
      const semsLeft = sems.length - i
      const ordered = cats.filter((c) => !grid[sem][c.name]).sort((a, b) => (PRIORITY[a.key] ?? 6) - (PRIORITY[b.key] ?? 6))
      for (const c of ordered) {
        const remaining = Math.max(leftAfter[c.name] - sumTypedLater(alloc, sems, i, c.name), 0)
        let want = c.key === 'PRJ' ? (semsLeft === 1 ? remaining : 0) : half(remaining / semsLeft + 0.24)
        want = Math.max(Math.min(want, remaining, Math.max(max - used, 0)), 0)
        grid[sem][c.name] = { value: want, typed: false }
        used += want
      }
    }
    for (const c of cats) leftAfter[c.name] = Math.max(leftAfter[c.name] - grid[sem][c.name].value, 0)
  })

  const totals = Object.fromEntries(sems.map((s) => [s, cats.reduce((a, c) => a + grid[s][c.name].value, 0)]))
  const totalLeft = cats.reduce((a, c) => a + leftAfter[c.name], 0)
  return { pm, cats, sems, grid, totals, leftAfter, totalLeft, current, unmatched, max, min: pm.min }
}

function sumTypedLater(alloc, sems, i, cat) {
  let s = 0
  for (let k = i + 1; k < sems.length; k++) { const v = alloc[sems[k]]?.[cat]; if (v !== undefined && v !== '') s += num(v) }
  return s
}

// Courses from the fetched VTOP course allocation, grouped by category, for "what to take next".
function catalogByKey(data) {
  const out = {}
  const done = new Set((data.grades || []).map((g) => g.code))
  for (const c of data.ffcsCatalog?.courses || []) {
    if (done.has(c.code)) continue
    const k = categoryKey(c.categoryLabel || c.category)
    ;(out[k] = out[k] || []).push(c)
  }
  return out
}

export function creditOutputs(m) {
  // Values that change as you type (kept in sync without redrawing the inputs).
  return {
    left: Object.fromEntries(m.cats.map((c) => [c.name, m.leftAfter[c.name]])),
    totals: m.totals,
    auto: Object.fromEntries(m.sems.map((s) => [s, Object.fromEntries(m.cats.map((c) => [c.name, m.grid[s][c.name].value]))])),
  }
}

export function creditStatusHtml(m) {
  const over = m.sems.filter((s) => m.totals[s] > m.max + 1e-9)
  const under = m.sems.filter((s, i) => m.totals[s] > 0 && m.totals[s] < m.min && i < m.sems.length - 1)
  const lines = []
  if (!m.cats.length) return ''
  if (m.totalLeft > 1e-9) lines.push(`<div class="notice bad">${f1(m.totalLeft)} credits are still unplanned: ${m.cats.filter((c) => m.leftAfter[c.name] > 1e-9).map((c) => `${esc(c.name)} ${f1(m.leftAfter[c.name])}`).join(', ')}. Add credits to a semester, or add a semester in the CGPA Planner.</div>`)
  else lines.push(`<div class="notice good">Every category is covered by the end of ${esc(m.sems[m.sems.length - 1] || 'the plan')}.</div>`)
  if (over.length) lines.push(`<div class="notice warn">Over the ${m.max}-credit cap in ${over.map(esc).join(', ')}. That needs extra NPTEL / open elective credits.</div>`)
  if (under.length) lines.push(`<div class="notice warn">Below the ${m.min}-credit minimum in ${under.map(esc).join(', ')}.</div>`)
  return lines.join('')
}

export function viewCredits(data) {
  const m = creditModel(data)
  const plan = data.plan || {}
  const next = m.sems.find((s, i) => !(i === 0 && m.pm.registered > 0)) // first semester you still have to plan
  const cat = catalogByKey(data)

  const setup = `<div class="card">
    <h2 style="margin-bottom:12px">Your programme</h2>
    <div class="form" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));display:grid;gap:12px">
      <label class="field">Total semesters<input data-cpset="totalSems" type="number" min="1" max="16" value="${esc(m.pm.totalSems)}"></label>
      <label class="field">Semesters completed<input data-cpset="completedSems" type="number" min="0" max="16" value="${esc(plan.completedSems ?? '')}" placeholder="${m.pm.autoCompleted} (auto)"></label>
      <label class="field">Max credits a semester<input data-cpset="maxPerSem" type="number" min="1" max="40" step="0.5" value="${esc(m.max)}"></label>
      <label class="field">Min credits a semester<input data-cpset="minPerSem" type="number" min="0" max="40" step="0.5" value="${esc(m.min)}"></label>
    </div>
    <p class="small muted" style="margin:10px 0 0">${m.pm.completedSems} of ${m.pm.totalSems} semesters done · ${m.sems.length} left${m.pm.registered ? ` (including ${esc(m.sems[0])}, where you're registered for ${f1(m.pm.registered)} credits)` : ''}. Shared with the CGPA Planner.</p>
  </div>`

  if (!m.cats.length) {
    return `<div class="page-head"><div><h1>Credit Planner</h1><p class="muted">Plan how many credits of each category to take in every remaining semester.</p></div></div>
      ${setup}
      <div class="card"><h2 style="margin-bottom:6px">No curriculum categories yet</h2><p class="muted" style="margin:0 0 12px">Sync from VTOP (Grade History or My Curriculum has them), or add your categories here.</p>${addCatForm()}</div>`
  }

  const table = `<div class="card">
    <div class="card-head"><div><h2>Semester-wise plan</h2><p class="small muted" style="margin:2px 0 0">Grey numbers are suggestions; type your own to change them. ${m.pm.registered ? `${esc(m.sems[0])} uses the courses you're registered for.` : ''}</p></div>
      <button class="sm ghost" data-action="cp-reset">Back to suggestions</button></div>
    <div class="table-wrap"><table class="cp-table">
      <thead><tr><th>Category</th><th class="num">Required</th><th class="num">Done</th><th class="num">Left</th>
        ${m.sems.map((s, i) => `<th class="num">${esc(s)}${i === 0 && m.pm.registered ? '<br><span class="pill accent">registered</span>' : ''}</th>`).join('')}
        <th class="num">Left after plan</th></tr></thead>
      <tbody>${m.cats.map((c) => `<tr>
        <td><b>${esc(c.name)}</b>${c.custom ? ` <button class="sm ghost" data-action="cp-del-cat" data-i="${c.idx}">Remove</button>` : ''}</td>
        <td class="num">${f1(c.required)}</td><td class="num">${f1(c.earned)}</td><td class="num"><b>${f1(c.left)}</b></td>
        ${m.sems.map((s) => {
          const g = m.grid[s][c.name]
          const typed = plan.catAlloc?.[s]?.[c.name]
          return `<td class="num"><input class="cp-in ${g.typed ? 'typed' : ''}" data-cpalloc="${esc(s)}|${esc(c.name)}" type="number" min="0" max="40" step="0.5" value="${typed !== undefined && typed !== '' ? esc(typed) : ''}" placeholder="${f1(g.value)}" aria-label="${esc(c.name)} credits in ${esc(s)}"></td>`
        }).join('')}
        <td class="num" data-cpleft="${esc(c.name)}"><span class="pill ${m.leftAfter[c.name] > 1e-9 ? 'bad' : 'good'}">${f1(m.leftAfter[c.name])}</span></td></tr>`).join('')}
      </tbody>
      <tfoot><tr><th>Semester total</th><th class="num">${f1(m.cats.reduce((a, c) => a + c.required, 0))}</th><th class="num">${f1(m.cats.reduce((a, c) => a + c.earned, 0))}</th><th class="num">${f1(m.cats.reduce((a, c) => a + c.left, 0))}</th>
        ${m.sems.map((s) => `<th class="num" data-cptotal="${esc(s)}">${totalPill(m, s)}</th>`).join('')}
        <th class="num" data-cptotalleft>${f1(m.totalLeft)}</th></tr></tfoot>
    </table></div>
    <div id="cp-status" style="margin-top:12px;display:grid;gap:8px">${creditStatusHtml(m)}</div>
  </div>`

  const nextCard = next ? (() => {
    const row = m.cats.map((c) => ({ c, v: m.grid[next][c.name].value })).filter((x) => x.v > 0)
    return `<div class="card">
      <div class="card-head"><div><h2>Next semester: ${esc(next)}</h2><p class="small muted" style="margin:2px 0 0">${f1(m.totals[next])} credits planned</p></div><a class="btn sm" href="#/builder">Open Timetable Builder</a></div>
      ${row.length ? `<div class="grid cols-2">${row.map(({ c, v }) => {
        const offered = cat[c.key] || []
        return `<div class="found-item" style="align-items:flex-start"><span><b>${esc(c.name)}</b><br><span class="small muted">${f1(v)} credits${offered.length ? ` · ${offered.length} course${offered.length === 1 ? '' : 's'} offered on VTOP, e.g. ${offered.slice(0, 3).map((o) => `${esc(o.code)} ${esc(o.title)}`).join(', ')}` : ''}</span></span></div>`
      }).join('')}</div>` : '<p class="muted" style="margin:0">Nothing planned for this semester.</p>'}
    </div>`
  })() : ''

  const unmatched = m.unmatched.length ? `<div class="notice warn">Registered courses whose category didn't match your curriculum: ${m.unmatched.map((c) => `${esc(c.code)} (${esc(c.category || 'no category')}, ${f1(c.credits)} cr)`).join(', ')}. Type their credits into the right row for ${esc(m.sems[0])}.</div>` : ''

  return `<div class="page-head"><div><h1>Credit Planner</h1><p class="muted">How many credits of each category are left, and how many to take in each remaining semester.</p></div></div>
    ${setup}
    ${unmatched}
    ${table}
    ${nextCard}
    <div class="card"><h2 style="margin-bottom:6px">Add a category</h2><p class="small muted" style="margin:0 0 12px">For requirements missing from your synced curriculum (for example a minor or honours track).</p>${addCatForm()}</div>`
}

function totalPill(m, s) {
  const t = m.totals[s]
  const cls = t > m.max + 1e-9 ? 'bad' : t > 0 && t < m.min ? 'warn' : 'accent'
  return `<span class="pill ${cls}">${f1(t)}</span>`
}

function addCatForm() {
  return `<form class="row" data-form="cp-add-cat">
    <input name="name" placeholder="Category, e.g. Discipline Elective" required style="flex:1;min-width:180px">
    <input name="required" type="number" min="0" max="200" step="0.5" placeholder="Required" required style="width:100px">
    <input name="earned" type="number" min="0" max="200" step="0.5" placeholder="Done" style="width:90px">
    <button class="primary" type="submit">Add</button></form>`
}

// Update numbers in place after typing (keeps the cursor in the box).
export function refreshCredits(data) {
  const m = creditModel(data)
  for (const s of m.sems) for (const c of m.cats) {
    const el = document.querySelector(`[data-cpalloc="${CSS.escape(s)}|${CSS.escape(c.name)}"]`)
    if (el) { el.placeholder = f1(m.grid[s][c.name].value); el.classList.toggle('typed', !!m.grid[s][c.name].typed) }
  }
  for (const c of m.cats) {
    const el = document.querySelector(`[data-cpleft="${CSS.escape(c.name)}"]`)
    if (el) el.innerHTML = `<span class="pill ${m.leftAfter[c.name] > 1e-9 ? 'bad' : 'good'}">${f1(m.leftAfter[c.name])}</span>`
  }
  for (const s of m.sems) { const el = document.querySelector(`[data-cptotal="${CSS.escape(s)}"]`); if (el) el.innerHTML = totalPill(m, s) }
  const tl = document.querySelector('[data-cptotalleft]'); if (tl) tl.textContent = f1(m.totalLeft)
  const st = document.getElementById('cp-status'); if (st) st.innerHTML = creditStatusHtml(m)
}
