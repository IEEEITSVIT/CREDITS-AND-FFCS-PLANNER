// CGPA Planner: credit guidelines per semester and the CGPA you need from here on.
import { academicStats, fmt, letterAtLeast } from './calc.js'
import { semesterAt, nextSemesterLabels } from './semesters.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const num = (v, d = 0) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? d : Number(v))
const f1 = (x) => fmt(x, Number(x) % 1 ? 1 : 0)
const half = (x) => Math.ceil(x * 2 - 1e-9) / 2 // round up to 0.5

export const PLAN_DEFAULTS = { totalSems: 8, maxPerSem: 27.5, minPerSem: 16, extraTotal: 0, target: '' }

function historySemRows(stats) {
  return stats.bySemester.filter((s) => s.sgpa != null && /^(Fall|Winter)/.test(s.label)).map((s) => ({ label: s.label, credits: s.credits, sgpa: Math.round(s.sgpa * 100) / 100 }))
}

export function planModel(data) {
  const stats = academicStats(data)
  const plan = { ...PLAN_DEFAULTS, ...(data.plan || {}) }
  const hasHistory = (data.grades || []).length > 0
  const rows = plan.semRows || historySemRows(stats)
  const fromRows = rows.reduce((a, r) => ({ c: a.c + num(r.credits), p: a.p + num(r.credits) * num(r.sgpa) }), { c: 0, p: 0 })

  // Where "so far" comes from: grade history, unless the semester table was edited by hand.
  const useRows = !!plan.semRows || !hasHistory
  const C0 = useRows ? fromRows.c : stats.gpaCredits
  const P0 = useRows ? fromRows.p : stats.gpaPoints
  const cgpaSoFar = C0 ? P0 / C0 : null
  const earned = useRows ? fromRows.c + num(plan.ngDone) : stats.earned
  const autoCompleted = useRows ? rows.length : new Set(stats.bySemester.filter((s) => /^(Fall|Winter)/.test(s.label)).map((s) => s.label)).size
  const completedSems = plan.completedSems === '' || plan.completedSems === undefined ? autoCompleted : num(plan.completedSems)

  const totalRequired = num(plan.totalRequired, stats.totalRequired)
  const totalSems = num(plan.totalSems, 8)
  const max = num(plan.maxPerSem, 27.5)
  const min = num(plan.minPerSem, 0)
  const extra = num(plan.extraTotal, 0)
  const remainingCredits = Math.max(totalRequired - earned, 0)
  const remainingSems = Math.max(totalSems - completedSems, 0)
  const registered = (data.current || []).reduce((a, c) => a + (Number(c.credits) || 0), 0)
  // This semester is fixed at what you're registered for; later ones can go up to the cap.
  const capacity = (registered > 0 && remainingSems ? Math.min(registered, max) + (remainingSems - 1) * max : remainingSems * max) + extra
  const avg = remainingSems ? remainingCredits / remainingSems : null
  const fastest = remainingCredits ? Math.max(Math.ceil((remainingCredits - extra) / max - 1e-9), 1) : 0

  // Semester-by-semester plan. The current semester uses the credits you're registered for.
  const firstLabel = semesterAt(new Date())
  const labels = remainingSems ? [firstLabel, ...nextSemesterLabels(firstLabel, remainingSems - 1)] : []
  const sems = []
  let left = remainingCredits, extraLeft = extra
  labels.forEach((label, i) => {
    const semsLeft = labels.length - i
    let credits
    if (i === 0 && registered > 0) credits = Math.min(registered, max + extraLeft)
    else credits = Math.min(half(left / semsLeft), max + extraLeft)
    credits = Math.max(Math.min(credits, left), 0)
    const extraUsed = Math.max(credits - max, 0)
    extraLeft -= extraUsed
    left -= credits
    sems.push({ label, credits, extraUsed, registered: i === 0 && registered > 0, belowMin: credits > 0 && credits < min && semsLeft > 1 })
  })

  let status
  if (!remainingCredits) status = { tone: 'good', text: 'You have met the total credit requirement. Check each curriculum category too.' }
  else if (!remainingSems) status = { tone: 'bad', text: `No semesters left in your plan, but ${f1(remainingCredits)} credits remain. Increase the number of semesters.` }
  else if (remainingCredits > capacity + 1e-9) status = { tone: 'bad', text: `${f1(remainingCredits)} credits can't fit in ${remainingSems} semester${remainingSems > 1 ? 's' : ''} at ${max} a semester${extra ? ` plus ${extra} extra` : ''}${registered ? ` (this semester counts as ${f1(Math.min(registered, max))}, what you're registered for)` : ''}. You'd need more semesters, or more extra credits (NPTEL / open electives).` }
  else if (avg > max + 1e-9) status = { tone: 'warn', text: `You need ${f1(avg)} credits a semester on average, above the ${max} cap. That works only with about ${f1(remainingCredits - remainingSems * max)} extra credits (NPTEL / open electives).` }
  else if (left > 1e-9) status = { tone: 'warn', text: `${f1(left)} credits are left over after the plan. Raise the extra credits or add a semester.` }
  else status = { tone: 'good', text: `About ${f1(avg)} credits a semester gets you there in ${remainingSems} semester${remainingSems > 1 ? 's' : ''}.${fastest < remainingSems ? ` Taking ${max} each time, you could finish in ${fastest}.` : ''}` }

  // CGPA outlook. Non-graded credits still to do don't affect CGPA.
  const ngLeft = num(plan.ngRemaining, ngRemainingFromCurriculum(data))
  const Rg = Math.max(remainingCredits - ngLeft, 0)
  const finalAt = (x) => (C0 + Rg ? (P0 + x * Rg) / (C0 + Rg) : null)
  let need = null
  const target = plan.target === '' ? null : num(plan.target)
  if (target !== null && Rg > 0) need = (target * (C0 + Rg) - P0) / Rg

  return { stats, plan, rows, useRows, hasHistory, C0, P0, cgpaSoFar, earned, completedSems, autoCompleted, totalRequired, totalSems, max, min, extra,
    remainingCredits, remainingSems, capacity, avg, fastest, sems, status, registered, ngLeft, Rg, finalAt, target, need }
}

function ngRemainingFromCurriculum(data) {
  const cat = (data.curriculum?.categories || []).find((c) => /non.?graded|ngcr/i.test(c.name))
  return cat ? Math.max(cat.required - cat.earned, 0) : 0
}

function field(name, label, value, attrs = '', hint = '') {
  return `<label class="field">${label}<input data-plan="${name}" value="${esc(value)}" inputmode="decimal" ${attrs}>${hint ? `<span class="small muted" style="font-weight:400">${hint}</span>` : ''}</label>`
}

export function plannerResultsHtml(data) {
  const m = planModel(data)
  const pct = m.totalRequired ? Math.min(m.earned / m.totalRequired, 1) : 0
  let needText = ''
  if (m.target !== null) {
    if (!m.Rg) needText = `<div class="notice">No graded credits left, so your CGPA stays at ${fmt(m.cgpaSoFar)}.</div>`
    else if (m.need > 10) needText = `<div class="notice bad">${fmt(m.target)} isn't reachable: even straight S (10) gives ${fmt(m.finalAt(10))}.</div>`
    else if (m.need <= 5) needText = `<div class="notice good">Passing everything (E or better) keeps you at or above ${fmt(m.target)}.</div>`
    else needText = `<div class="notice">For a final CGPA of <strong>${fmt(m.target)}</strong> you need an average SGPA of <strong>${fmt(m.need)}</strong> over your remaining ${f1(m.Rg)} graded credits (${m.need % 1 && m.need > 5 ? `between ${letterAtLeast(Math.floor(m.need))} and ${letterAtLeast(Math.ceil(m.need))}` : `${letterAtLeast(m.need)} or better`} grades).</div>`
  }
  return `
  <div class="notice ${m.status.tone}" style="margin-bottom:16px">${esc(m.status.text)}</div>
  <div class="grid cols-4">
    <div class="card stat"><div class="label">Credits done</div><div class="value">${fmt(m.earned, m.earned % 1 ? 1 : 0)}</div><div class="sub">of ${m.totalRequired}</div></div>
    <div class="card stat"><div class="label">Credits left</div><div class="value">${fmt(m.remainingCredits, m.remainingCredits % 1 ? 1 : 0)}</div><div class="sub">${m.ngLeft ? `${f1(m.ngLeft)} non-graded` : 'all graded'}</div></div>
    <div class="card stat"><div class="label">Semesters left</div><div class="value">${m.remainingSems}</div><div class="sub">${m.completedSems} of ${m.totalSems} done</div></div>
    <div class="card stat"><div class="label">Average needed</div><div class="value">${m.avg === null ? '--' : f1(m.avg)}</div><div class="sub">credits a semester (max ${m.max})</div></div>
  </div>
  <div class="progress" style="margin:16px 0 4px"><span style="width:${pct * 100}%"></span></div>
  <div class="small muted">${Math.round(pct * 100)}% of the programme's credits done</div>

  <div class="grid cols-2" style="margin-top:16px">
    <div class="card">
      <h2 style="margin-bottom:4px">Credit plan</h2>
      <p class="small muted" style="margin:0 0 12px">Spread evenly, at most ${m.max} a semester${m.extra ? `, using up to ${m.extra} extra credits` : ''}.${m.registered ? ' This semester uses the credits you are registered for.' : ''}</p>
      ${m.sems.length ? `<div class="table-wrap"><table><thead><tr><th>Semester</th><th class="num">Credits</th><th class="num">Extra</th><th class="num">Total after</th></tr></thead><tbody>
        ${(() => { let run = m.earned; return m.sems.map((s) => { run += s.credits; return `<tr><td>${esc(s.label)}${s.registered ? ' <span class="pill accent">registered</span>' : ''}${s.belowMin ? ` <span class="pill warn" title="Below the ${m.min}-credit minimum">below min</span>` : ''}</td><td class="num">${fmt(s.credits, s.credits % 1 ? 1 : 0)}</td><td class="num">${s.extraUsed ? f1(s.extraUsed) : '-'}</td><td class="num">${fmt(run, run % 1 ? 1 : 0)}</td></tr>` }).join('') })()}
      </tbody></table></div>` : '<p class="muted">No semesters left in the plan.</p>'}
    </div>
    <div class="card">
      <h2 style="margin-bottom:4px">CGPA outlook</h2>
      <p class="small muted" style="margin:0 0 12px">CGPA so far: <strong>${fmt(m.cgpaSoFar)}</strong> over ${f1(m.C0)} graded credits${m.useRows && m.hasHistory ? ' (from the semester table below)' : ''}.</p>
      ${needText || '<p class="small muted" style="margin:0">Set a target CGPA on the right to see the SGPA you need, or enter your expected SGPA for each remaining semester below.</p>'}
    </div>
  </div>`
}

export function viewPlanner(data) {
  const m = planModel(data)
  const p = m.plan
  return `
  <div class="page-head"><div><h1>CGPA Planner</h1><p class="muted">Credit guidelines for the rest of your programme, and the CGPA you need.</p></div></div>
  <div class="grid cols-3-1">
    <div class="stack">
      <div class="stack" id="plan-out">${plannerResultsHtml(data)}</div>
      <div class="card" id="plan-exp">${expectedCardHtml(data)}</div>
    </div>
    <div class="stack">
      <div class="card">
        <h2 style="margin-bottom:12px">Your programme</h2>
        <div class="form">
          ${field('totalSems', 'Total semesters in your programme', p.totalSems, 'type="number" min="1" max="16" step="1"', 'e.g. 8 for a 4-year B.Tech')}
          ${field('completedSems', 'Semesters completed', p.completedSems ?? '', `type="number" min="0" max="16" step="1" placeholder="${m.autoCompleted} (auto)"`, 'Leave blank to count from your grade history. The current semester is not completed yet.')}
          ${field('totalRequired', 'Total credits required', p.totalRequired ?? '', `type="number" min="1" max="400" step="0.5" placeholder="${m.stats.totalRequired}"`)}
        </div>
      </div>
      <div class="card">
        <h2 style="margin-bottom:4px">Credit guidelines</h2>
        <p class="small muted" style="margin:0 0 12px">Defaults follow FFCS: up to 27.5 credits a semester. Extra NPTEL or open elective credits beyond that depend on your eligibility and what's offered, so enter your own.</p>
        <div class="form">
          ${field('maxPerSem', 'Maximum credits per semester', p.maxPerSem, 'type="number" min="1" max="40" step="0.5"')}
          ${field('minPerSem', 'Minimum credits per semester', p.minPerSem, 'type="number" min="0" max="40" step="0.5"', 'Check your batch regulations.')}
          ${field('extraTotal', 'Extra credits available (NPTEL / open electives)', p.extraTotal, 'type="number" min="0" max="60" step="0.5"', 'Total over the remaining semesters, beyond the per-semester cap. Varies by student.')}
          ${field('ngRemaining', 'Non-graded credits still to do', p.ngRemaining ?? '', `type="number" min="0" max="60" step="0.5" placeholder="${m.ngLeft}"`, 'NGCR credits count toward the total but not CGPA.')}
        </div>
      </div>
      <div class="card">
        <h2 style="margin-bottom:12px">Target CGPA</h2>
        ${field('target', 'Final CGPA you are aiming for', p.target, 'type="number" min="0" max="10" step="0.01" placeholder="e.g. 9.00"')}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><div><h2>Semester-wise CGPA</h2><p class="small muted" style="margin:2px 0 0">${m.hasHistory && !p.semRows ? 'Filled from your grade history. Edit any row to try a what-if.' : 'Enter each semester\'s graded credits and SGPA.'} CGPA = sum(credits x SGPA) / sum(credits).</p></div>
      <div class="row">${p.semRows && m.hasHistory ? '<button class="sm ghost" data-action="plan-reset-rows">Reset from grade history</button>' : ''}<button class="sm" data-action="plan-add-row">Add semester</button></div></div>
    <div class="calc-list" id="plan-rows">${m.rows.map((r, i) => `
      <div class="calc-row plan-row">
        <label class="calc-name"><span class="muted small">Semester</span><input data-semrow="label" data-i="${i}" value="${esc(r.label)}" placeholder="Fall 2024-25"></label>
        <label class="calc-credits"><span class="muted small">Credits</span><input data-semrow="credits" data-i="${i}" type="number" min="0" max="40" step="0.5" value="${esc(r.credits)}"></label>
        <label class="calc-credits"><span class="muted small">SGPA</span><input data-semrow="sgpa" data-i="${i}" type="number" min="0" max="10" step="0.01" value="${esc(r.sgpa)}"></label>
        <button class="ghost sm calc-del" data-action="plan-del-row" data-i="${i}">Remove</button>
      </div>`).join('') || '<p class="muted small">No semesters yet.</p>'}</div>
    <p class="small" style="margin:12px 0 0">CGPA from this table: <strong id="plan-rows-cgpa">${fmt(rowsCgpa(m.rows))}</strong>${m.hasHistory ? ` <span class="muted">(grade history: ${fmt(m.stats.cgpa)}. Small differences come from repeated courses.)</span>` : ''}</p>
  </div>`
}

export function rowsCgpa(rows) {
  const t = rows.reduce((a, r) => ({ c: a.c + num(r.credits), p: a.p + num(r.credits) * num(r.sgpa) }), { c: 0, p: 0 })
  return t.c ? t.p / t.c : null
}

export function ensureSemRows(data) {
  if (!data.plan) data.plan = {}
  if (!data.plan.semRows) data.plan.semRows = historySemRows(academicStats(data))
  return data.plan.semRows
}

// Your expected SGPA for each remaining semester -> CGPA after each one, and the final CGPA.
// Non-graded credits still to do are spread across semesters and left out of the GPA.
export function expectedOutlook(data) {
  const m = planModel(data)
  const exp = m.plan.expected || {}
  const share = m.remainingCredits ? m.Rg / m.remainingCredits : 0
  let C = m.C0, P = m.P0, chain = true, filled = 0
  const rows = m.sems.map((s) => {
    const v = exp[s.label]
    const sgpa = v === '' || v === null || v === undefined ? null : Math.min(Math.max(num(v), 0), 10)
    const graded = s.credits * share
    if (sgpa !== null) filled++
    if (sgpa !== null && chain) { C += graded; P += graded * sgpa } else chain = false
    return { label: s.label, credits: s.credits, graded, sgpa, after: chain && C ? P / C : null }
  })
  const done = rows.length > 0 && filled === rows.length
  const lastKnown = [...rows].reverse().find((r) => r.after !== null)
  return { m, rows, done, final: done ? rows[rows.length - 1].after : null, lastKnown }
}

function expectedSummary(o) {
  if (!o.rows.length) return '<p class="muted small" style="margin:0">No semesters left in the plan.</p>'
  if (o.done) {
    const d = o.m.cgpaSoFar !== null ? o.final - o.m.cgpaSoFar : null
    return `<div class="muted small">Expected final CGPA</div><div class="result-big">${fmt(o.final)}</div>
      ${d !== null ? `<div class="small"><span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '-'}${fmt(Math.abs(d))}</span> <span class="muted">from ${fmt(o.m.cgpaSoFar)} now</span></div>` : ''}`
  }
  return `<p class="small muted" style="margin:0">Enter an SGPA for every remaining semester to see your final CGPA.${o.lastKnown ? ` After ${esc(o.lastKnown.label)}: <strong>${fmt(o.lastKnown.after)}</strong>.` : ''}</p>`
}

export function expectedCardHtml(data) {
  const o = expectedOutlook(data)
  const exp = o.m.plan.expected || {}
  return `
    <div class="card-head"><div><h2>Your expected SGPA</h2><p class="small muted" style="margin:2px 0 0">For each remaining semester. Credits come from the credit plan above.</p></div>
      <div class="row"><input data-exp-all type="number" min="0" max="10" step="0.01" placeholder="SGPA" aria-label="Same SGPA for all" style="width:90px"><button class="sm" data-action="plan-exp-all">Same for all</button>
      ${Object.keys(exp).length ? '<button class="sm ghost" data-action="plan-exp-clear">Clear</button>' : ''}</div></div>
    ${o.rows.length ? `<div class="calc-list">${o.rows.map((r, i) => `
      <div class="calc-row plan-row">
        <div class="calc-name"><span class="muted small">Semester</span><strong style="padding:8px 0">${esc(r.label)}</strong></div>
        <div class="calc-credits"><span class="muted small">Credits</span><span style="padding:8px 0">${fmt(r.credits, r.credits % 1 ? 1 : 0)}</span></div>
        <label class="calc-credits"><span class="muted small">Expected SGPA</span><input data-exp="${esc(r.label)}" type="number" min="0" max="10" step="0.01" inputmode="decimal" value="${esc(exp[r.label] ?? '')}" placeholder="e.g. 9.2"></label>
        <div class="calc-credits"><span class="muted small">CGPA after</span><strong data-exp-after="${i}" style="padding:8px 0">${r.after === null ? '--' : fmt(r.after)}</strong></div>
      </div>`).join('')}</div>` : ''}
    <div id="plan-exp-summary" style="margin-top:14px">${expectedSummary(o)}</div>`
}

// Update just the numbers (keeps focus in the SGPA box you're typing in).
export function refreshExpectedNumbers(data) {
  const o = expectedOutlook(data)
  o.rows.forEach((r, i) => {
    const el = document.querySelector(`[data-exp-after="${i}"]`)
    if (el) el.textContent = r.after === null ? '--' : fmt(r.after)
  })
  const sum = document.getElementById('plan-exp-summary')
  if (sum) sum.innerHTML = expectedSummary(o)
}
