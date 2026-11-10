// FFCS timetable generator: every clash-free way to pick one section (slot + faculty) per course.
// Clashes are decided on actual class times (day + start/end), never on slot names.
// VIT rule: a course's theory and lab sit in opposite halves of the day
// (morning theory with an evening lab, evening theory with a morning lab).
import { slotMeetings, meetingsClash, fitsFilter, pairOk, theoryOf, labOf, DAYS } from './slots.js'

const baseCode = (code) => String(code || '').toUpperCase().replace(/[LPEN]$/, '')
const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI']
const buildingOf = (venue) => (String(venue || '').toUpperCase().match(/^[A-Z]+/) || [''])[0]
const FILTER_NAME = { morning: 'morning theory', afternoon: 'evening theory' }

// courses: [{ id, code, title, credits, options: [{ id, slot, faculty, venue, off, star }] }]  (options in priority order)
// opts: { filter: 'mixed'|'morning'|'afternoon', avoidWeekend, sameFaculty,
//         earliest, latest (minutes from midnight or null), freeDay, maxLabDays, sameBuilding, limit }
export function generate(courses, opts = {}) {
  const { filter = 'mixed', avoidWeekend = false, sameFaculty = false, earliest = null, latest = null,
    freeDay = false, maxLabDays = null, sameBuilding = false, dayOff = '', avoidFaculty = [], limit = 3000, nodeLimit = 500000 } = opts
  const avoid = (avoidFaculty || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean)
  const problems = []
  const prepared = []
  for (const c of courses) {
    const all = (c.options || [])
      .map((o, rank) => ({ ...o, rank, ...slotMeetings(o.slot) }))
      .filter((o) => !o.off && !o.unknown.length)
    const timeOk = (o) => o.meetings.every((m) => (earliest === null || m.s >= earliest) && (latest === null || m.e <= latest) && m.day !== dayOff)
    const facultyOk = (o) => !avoid.some((a) => String(o.faculty || '').toLowerCase().includes(a))
    const cands = all.filter((o) => fitsFilter(o.meetings, filter, avoidWeekend) && timeOk(o) && facultyOk(o) && pairOk(theoryOf(o.meetings), labOf(o.meetings)))
    const base = baseCode(c.code)
    const isTh = (o) => o.meetings.length && o.meetings.every((m) => m.kind === 'Theory')
    const isLab = (o) => o.meetings.length && o.meetings.every((m) => m.kind === 'Lab')
    const name = c.code || c.title
    const why = [
      filter !== 'mixed' ? `"${FILTER_NAME[filter]}"` : '',
      avoidWeekend ? 'no weekends' : '',
      earliest !== null || latest !== null ? 'your start/end times' : '',
      dayOff ? `${dayOff} off` : '',
      avoid.length ? 'the faculty you avoid' : '',
    ].filter(Boolean).join(', ')
    const reason = `${why ? ` with ${why}` : ''}${all.length ? '' : ' (all sections are switched off)'}`
    if (all.some(isTh) && all.some(isLab) && cands.every((o) => isTh(o) || isLab(o))) {
      // Theory and lab offered as separate sections of one course: pick one of each.
      const th = cands.filter(isTh), lab = cands.filter(isLab)
      if (!th.length) problems.push(`${name} theory: no section fits${reason}`)
      if (!lab.length) problems.push(`${name} lab: no section fits${reason}`)
      prepared.push({ course: c, cands: th, base, part: 'theory' }, { course: c, cands: lab, base, part: 'lab' })
    } else {
      if (!cands.length) problems.push(`${name}: no section fits${reason}`)
      prepared.push({ course: c, cands, base })
    }
  }
  if (problems.length) return { results: [], groups: [], problems, truncated: false, partial: null }

  const whole = (picks) => {
    const ms = picks.flatMap((p) => p.opt.meetings)
    if (freeDay && WEEKDAYS.every((d) => ms.some((m) => m.day === d))) return false
    if (maxLabDays !== null && new Set(labOf(ms).map((m) => m.day)).size > maxLabDays) return false
    if (sameBuilding) {
      const b = new Set(picks.map((p) => buildingOf(p.opt.venue)).filter(Boolean))
      if (b.size > 1) return false
    }
    return true
  }

  const run = (allowSkip) => {
    const order = [...prepared].sort((a, b) => a.cands.length - b.cands.length)
    const found = []
    let nodes = 0, truncated = false, best = 0
    const chosen = []
    const dfs = (i, skipped) => {
      if (found.length >= limit || nodes > nodeLimit) { truncated = true; return }
      if (allowSkip && order.length - skipped.length < best) return // can't beat the best partial
      if (i === order.length) {
        const placed = order.length - skipped.length
        if (!chosen.length || !whole(chosen)) return
        if (allowSkip) {
          if (placed > best) { best = placed; found.length = 0 }
          if (placed < best) return
        }
        found.push({ picks: chosen.slice(), skipped: skipped.slice() })
        return
      }
      const { cands, base } = order[i]
      const partners = base ? chosen.filter((x) => x.base === base) : []
      const partnerFaculty = sameFaculty ? partners[0]?.opt.faculty : null
      for (const opt of cands) {
        nodes++
        if (partnerFaculty && opt.faculty !== partnerFaculty) continue
        if (chosen.some((x) => meetingsClash(x.opt.meetings, opt.meetings))) continue
        if (partners.length) {
          const ms = [...partners.flatMap((x) => x.opt.meetings), ...opt.meetings]
          if (!pairOk(theoryOf(ms), labOf(ms))) continue
        }
        chosen.push({ course: order[i].course, opt, base, part: order[i].part })
        dfs(i + 1, skipped)
        chosen.pop()
        if (truncated) return
      }
      if (allowSkip) dfs(i + 1, [...skipped, order[i]])
    }
    dfs(0, [])
    return { found, truncated }
  }

  let { found, truncated } = run(false)
  let partial = null
  let report = []
  if (!found.length) {
    report = clashReport(prepared, sameFaculty)
    // Best effort: the timetables that fit the most subjects.
    const p = run(true)
    if (p.found.length && p.found[0].picks.length) {
      found = p.found
      truncated = p.truncated
      partial = { fitted: found[0].picks.length, total: prepared.length }
    }
  }

  const results = found.map(({ picks, skipped }) => score(picks, skipped))
  results.sort((a, b) => b.stars - a.stars || a.rank - b.rank || a.days - b.days || a.gaps - b.gaps)
  return { results, groups: groupByLayout(results), problems: report, truncated, partial }
}

function score(picks, skipped = []) {
  const meetings = picks.flatMap((p) => p.opt.meetings)
  const days = new Set(meetings.map((m) => m.day))
  let gaps = 0
  for (const d of days) {
    const ms = meetings.filter((m) => m.day === d).sort((a, b) => a.s - b.s)
    for (let k = 1; k < ms.length; k++) gaps += Math.max(ms[k].s - ms[k - 1].e, 0)
  }
  return {
    picks: picks.map((p) => ({ courseId: p.course.id, code: p.course.code, title: p.course.title + (p.part ? ` (${p.part})` : ''), credits: p.part === 'lab' ? 0 : p.course.credits, part: p.part || null, optionId: p.opt.id, slot: p.opt.slot, faculty: p.opt.faculty, venue: p.opt.venue, star: !!p.opt.star, rank: p.opt.rank })),
    skipped: skipped.map((s) => `${s.course.code || s.course.title}${s.part ? ` ${s.part}` : ''}`),
    stars: picks.filter((p) => p.opt.star).length,
    rank: picks.reduce((a, p) => a + p.opt.rank, 0),
    days: days.size,
    labDays: new Set(labOf(meetings).map((m) => m.day)).size,
    start: Math.min(...meetings.map((m) => m.s)),
    end: Math.max(...meetings.map((m) => m.e)),
    gaps,
  }
}

// Same slots, different faculty = one layout with several faculty variants.
export function groupByLayout(results) {
  const map = new Map()
  for (const r of results) {
    const key = r.picks.map((p) => `${p.code}|${p.part || ''}|${p.slot}`).sort().join(';')
    if (!map.has(key)) map.set(key, { key, variants: [] })
    map.get(key).variants.push(r)
  }
  return [...map.values()]
}

// When nothing fits, name the course pairs that can never sit together.
function clashReport(prepared, sameFaculty) {
  const out = []
  const label = (p) => `${p.course.code || p.course.title}${p.part ? ` ${p.part}` : ''}`
  for (let i = 0; i < prepared.length; i++) for (let j = i + 1; j < prepared.length; j++) {
    const a = prepared[i], b = prepared[j]
    const same = a.base && a.base === b.base
    const ok = a.cands.some((x) => b.cands.some((y) => !meetingsClash(x.meetings, y.meetings) && (!sameFaculty || !same || x.faculty === y.faculty)
      && (!same || pairOk(theoryOf([...x.meetings, ...y.meetings]), labOf([...x.meetings, ...y.meetings])))))
    if (!ok) out.push(same
      ? `${label(a)} and ${label(b)} can't be paired: theory and lab must be in opposite halves (morning theory with evening lab, or evening theory with morning lab)${sameFaculty ? ' with the same faculty' : ''}, without a time clash`
      : `${label(a)} and ${label(b)} clash in every combination (their class times overlap)`)
  }
  if (!out.length) out.push('Every pair fits on its own, but no full combination does with these filters. Try switching on more sections or loosening a filter.')
  return out
}

// Day -> sorted meetings with course info, for drawing a result.
export function weekView(result) {
  const byDay = {}
  for (const p of result.picks) {
    const { meetings } = slotMeetings(p.slot)
    for (const m of meetings) (byDay[m.day] = byDay[m.day] || []).push({ ...m, code: p.code, title: p.title, faculty: p.faculty, venue: p.venue })
  }
  return DAYS.filter((d) => byDay[d]).map((d) => ({ day: d, items: byDay[d].sort((a, b) => a.s - b.s) }))
}

// ---- clash helpers for the UI ----
export const optionMeetings = (o) => slotMeetings(o.slot).meetings

// Why section `o` of course `c` can't sit with the sections picked for other courses.
export function clashReasons(c, o, others) {
  const ms = optionMeetings(o)
  const out = []
  for (const x of others) {
    if (x.course === c) continue
    const xm = optionMeetings(x.opt)
    if (meetingsClash(ms, xm)) out.push({ type: 'time', code: x.course.code || x.course.title, slot: x.opt.slot, faculty: x.opt.faculty })
    else if (baseCode(c.code) && baseCode(c.code) === baseCode(x.course.code) && !pairOk(theoryOf([...ms, ...xm]), labOf([...ms, ...xm])))
      out.push({ type: 'pair', code: x.course.code, slot: x.opt.slot, faculty: x.opt.faculty })
  }
  return out
}

// For each pair of subjects: how many section combinations fit together.
export function clashMatrix(courses) {
  const list = courses.map((c) => ({ c, opts: (c.options || []).filter((o) => !o.off).map((o) => ({ o, ms: optionMeetings(o) })).filter((x) => x.ms.length) }))
  const rows = []
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j]
    const same = baseCode(a.c.code) && baseCode(a.c.code) === baseCode(b.c.code)
    let ok = 0
    for (const x of a.opts) for (const y of b.opts) {
      if (meetingsClash(x.ms, y.ms)) continue
      if (same && !pairOk(theoryOf([...x.ms, ...y.ms]), labOf([...x.ms, ...y.ms]))) continue
      ok++
    }
    const total = a.opts.length * b.opts.length
    if (total) rows.push({ a: a.c.code || a.c.title, b: b.c.code || b.c.title, ok, total, same })
  }
  return rows.sort((x, y) => x.ok / x.total - y.ok / y.total)
}
