// VIT semester calendar: Fall runs June-November, Winter runs December-May.
// "Fall Semester 2026-27" = Jun 2026 - Nov 2026; "Winter Semester 2026-27" = Dec 2026 - May 2027.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

export function parseSemesterName(name) {
  const t = String(name || '')
  const y = t.match(/(20\d{2})\s*[-/]\s*(\d{2,4})/) || t.match(/(20\d{2})/)
  const startYear = y ? parseInt(y[1], 10) : null
  const special = /\b(weekend|inter|intra)\b|wisem/i.test(t)
  const term = special ? 'Other' : /\bfall\b/i.test(t) ? 'Fall' : /\bwinter\b/i.test(t) ? 'Winter' : /summer|short/i.test(t) ? 'Summer' : 'Other'
  if (startYear === null) return { term, startYear, start: null, end: null, key: -1 }
  let start, end
  if (term === 'Fall') { start = new Date(startYear, 5, 1); end = new Date(startYear, 10, 30, 23, 59) }
  else if (term === 'Winter') { start = new Date(startYear, 11, 1); end = new Date(startYear + 1, 4, 31, 23, 59) }
  else if (term === 'Summer') { start = new Date(startYear + 1, 4, 15); end = new Date(startYear + 1, 6, 15) }
  else { start = new Date(startYear, 6, 1); end = new Date(startYear, 10, 30) }
  // Sort key in months; regular semesters sort ahead of special ones that start the same month.
  const key = start.getFullYear() * 12 + start.getMonth() + (term === 'Fall' || term === 'Winter' ? 0 : 0.5)
  return { term, startYear, start, end, key }
}

export const isRegular = (name) => /\b(fall|winter)\b/i.test(name || '') && !/\b(weekend|inter|intra)\b|wisem/i.test(name || '')

// Newest first.
export function sortSemesters(list, nameOf = (s) => s.name) {
  return [...list].sort((a, b) => parseSemesterName(nameOf(b)).key - parseSemesterName(nameOf(a)).key)
}

// VIT calendar rule. June-November: current = Fall, upcoming = Winter (same academic year),
// previous = Winter of the year before. December-May: current = Winter, upcoming = next Fall,
// previous = Fall of the same academic year.
export function calendarSemesters(today = new Date()) {
  const m = today.getMonth(), y = today.getFullYear()
  const mk = (term, startYear) => ({ term, startYear, label: `${term} ${startYear}-${String(startYear + 1).slice(2)}` })
  if (m >= 5 && m <= 10) return { previous: mk('Winter', y - 1), current: mk('Fall', y), upcoming: mk('Winter', y) }
  const wy = m === 11 ? y : y - 1
  return { previous: mk('Fall', wy), current: mk('Winter', wy), upcoming: mk('Fall', wy + 1) }
}

// Find the VTOP semester (regular, not weekend/inter) matching a calendar semester.
export function findSemester(semesters, cal) {
  return semesters.find((s) => {
    if (!isRegular(s.name)) return false
    const p = parseSemesterName(s.name)
    return p.term === cal.term && p.startYear === cal.startYear
  }) || null
}

export function currentAndUpcoming(semesters, today = new Date()) {
  const cal = calendarSemesters(today)
  return {
    previousSemId: findSemester(semesters, cal.previous)?.id ?? null,
    currentSemId: findSemester(semesters, cal.current)?.id ?? null,
    upcomingSemId: findSemester(semesters, cal.upcoming)?.id ?? null,
  }
}

// The semester you'd be in on a date, as a label: "Fall 2026-27".
export function semesterAt(date) {
  return calendarSemesters(date).current.label
}

// Exam month in grade history -> the semester it belongs to. Fall exams finish in Nov/Dec,
// Winter exams in Apr/May; so Jul-Dec -> Fall, Jan-Jun -> Winter of the previous academic year.
export function semesterOfExam(examMonth) {
  const t = String(examMonth || '').toLowerCase()
  const y = t.match(/(20\d{2})/)
  const mon = Object.keys(MONTHS).find((k) => t.includes(k))
  if (!y || mon === undefined) return null
  const year = parseInt(y[1], 10)
  const m = MONTHS[mon]
  if (m >= 6) return { label: `Fall ${year}-${String(year + 1).slice(2)}`, key: year * 12 + 5 }
  return { label: `Winter ${year - 1}-${String(year).slice(2)}`, key: (year - 1) * 12 + 11 }
}

// Next n regular semester labels after a given label ("Fall 2026-27" -> "Winter 2026-27", "Fall 2027-28", ...)
export function nextSemesterLabels(fromLabel, n) {
  const m = String(fromLabel || '').match(/(Fall|Winter)\s+(20\d{2})/)
  if (!m) return Array.from({ length: n }, (_, i) => `Semester +${i + 1}`)
  let term = m[1], y = parseInt(m[2], 10)
  const out = []
  for (let i = 0; i < n; i++) {
    if (term === 'Fall') term = 'Winter'
    else { term = 'Fall'; y += 1 }
    out.push(`${term} ${y}-${String(y + 1).slice(2)}`)
  }
  return out
}
