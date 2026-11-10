import { semesterOfExam } from './semesters.js'

// Academic calculations: CGPA, SGPA, credits, projections, target grade.
// VIT 10-point scale. F and N carry 0 points and count in the GPA until cleared; P/W/U etc. don't.

export const GRADE_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0, N: 0 }
export const LETTERS = ['S', 'A', 'B', 'C', 'D', 'E', 'F']
const PASS = new Set(['S', 'A', 'B', 'C', 'D', 'E', 'P'])
const IGNORE = new Set(['W', 'WW', 'U', 'AB', '-', ''])

export const isGraded = (g) => g in GRADE_POINTS
export const isPass = (g) => PASS.has(g)
export const isFail = (g) => g === 'F' || g === 'N' || g === 'FAIL'

// Non-graded (NGCR) courses: their credits count towards the degree, but not towards SGPA/CGPA.
const NG_TEXT = /\bngcr\b|non[\s-]?graded|\bng\b/i
export const isNonGraded = (c) =>
  c.ng === true || (c.ng !== false && (String(c.grade || '').toUpperCase() === 'P' || NG_TEXT.test(`${c.type || ''} ${c.category || ''} ${c.distribution || ''}`)))
// Credit earned? Graded: E or better. Non-graded: anything that isn't a fail.
export const earnsCredit = (c) => {
  const g = String(c.grade || '').toUpperCase()
  return isNonGraded(c) ? !!g && !isFail(g) && !IGNORE.has(g) : isPass(g)
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

// "Nov-2024" / "NOV 2024" / "2024-11" -> sortable number; unknown -> null
export function examKey(s) {
  const t = String(s || '').toLowerCase()
  const y = t.match(/(20\d{2})/)
  if (!y) return null
  const mon = Object.keys(MONTHS).find((m) => t.includes(m))
  const numMon = t.match(/20\d{2}[-/](\d{1,2})/)
  const month = mon ? MONTHS[mon] : numMon ? parseInt(numMon[1], 10) : 6
  return parseInt(y[1], 10) * 12 + month
}

const round2 = (x) => Math.round(x * 100) / 100

// Latest attempt per course code (repeat-course grade replacement).
export function effectiveCourses(grades) {
  const best = new Map()
  ;(grades || []).forEach((g, i) => {
    const grade = String(g.grade || '').toUpperCase()
    if (IGNORE.has(grade)) return
    const k = examKey(g.examMonth) ?? -1
    const prev = best.get(g.code)
    if (!prev || k > prev._k || (k === prev._k && i > prev._i)) best.set(g.code, { ...g, grade, _k: k, _i: i })
  })
  return [...best.values()]
}

export function gpaOf(courses) {
  let pts = 0
  let cr = 0
  for (const c of courses) {
    const g = String(c.grade || '').toUpperCase()
    if (!isGraded(g) || !(c.credits > 0) || isNonGraded(c)) continue
    pts += c.credits * GRADE_POINTS[g]
    cr += c.credits
  }
  return { points: pts, credits: cr, gpa: cr ? pts / cr : null }
}

// Grade history is grouped by semester: Fall (exams Jul-Dec) / Winter (exams Jan-Jun).
export function semesterLabel(examMonth) {
  return semesterOfExam(examMonth)?.label || examMonth || 'Unknown'
}
const semKey = (examMonth) => semesterOfExam(examMonth)?.key ?? examKey(examMonth) ?? 1e9

export function academicStats(data) {
  const grades = data.grades || []
  const eff = effectiveCourses(grades)
  const { points, credits, gpa } = gpaOf(eff)
  const earned = eff.filter(earnsCredit).reduce((s, c) => s + (c.credits || 0), 0)
  const ngEarned = eff.filter((c) => isNonGraded(c) && earnsCredit(c)).reduce((s, c) => s + (c.credits || 0), 0)
  const failed = eff.filter((c) => isFail(c.grade))
  const effKeys = new Set(eff.map((c) => `${c.code}|${c._i}`))
  const superseded = grades.filter((g, i) => !effKeys.has(`${g.code}|${i}`) && !IGNORE.has(String(g.grade).toUpperCase()))

  // Semester-wise SGPA and running CGPA
  const sems = new Map()
  grades.forEach((g, i) => {
    const label = semesterLabel(g.examMonth)
    if (!sems.has(label)) sems.set(label, { label, key: semKey(g.examMonth), items: [] })
    sems.get(label).items.push({ ...g, _i: i })
  })
  const semesters = [...sems.values()].sort((a, b) => a.key - b.key)
  const bySemester = semesters.map((s) => {
    const sg = gpaOf(s.items)
    const upTo = grades.filter((g) => semKey(g.examMonth) <= s.key)
    const cg = gpaOf(effectiveCourses(upTo))
    return { label: s.label, sgpa: sg.gpa, credits: sg.credits, cgpa: cg.gpa, count: s.items.length }
  })

  const curriculum = data.curriculum || null
  const totalRequired = data.settings?.totalRequired || curriculum?.totalRequired || 160
  const currentCredits = (data.current || []).reduce((s, c) => s + (Number(c.credits) || 0), 0)
  const pending = Math.max(totalRequired - earned, 0)

  return {
    cgpa: gpa,
    officialCgpa: data.summary?.cgpa ?? null,
    gpaCredits: credits,
    gpaPoints: points,
    earned,
    ngEarned,
    totalRequired,
    pending,
    currentCredits,
    pendingAfterCurrent: Math.max(pending - currentCredits, 0),
    failed,
    superseded,
    effective: eff,
    bySemester,
    progress: totalRequired ? Math.min(earned / totalRequired, 1) : 0,
  }
}

// Projected SGPA/CGPA if current courses get the given grades. A current course already in
// history (repeat) replaces the old attempt.
export function project(grades, current) {
  const curCodes = new Set(current.map((c) => c.code).filter(Boolean))
  const base = effectiveCourses(grades).filter((c) => !curCodes.has(c.code))
  const baseGpa = gpaOf(base)
  const graded = current.filter((c) => !isNonGraded({ ...c, grade: c.expected }) && isGraded(c.expected) && Number(c.credits) > 0)
  const sem = gpaOf(graded.map((c) => ({ credits: Number(c.credits), grade: c.expected })))
  const total = gpaOf([...base, ...graded.map((c) => ({ credits: Number(c.credits), grade: c.expected }))])
  return {
    sgpa: sem.gpa,
    semCredits: sem.credits,
    cgpa: total.gpa,
    baseCgpa: baseGpa.gpa,
    ungraded: current.filter((c) => Number(c.credits) > 0 && !isNonGraded({ ...c, grade: c.expected }) && !isGraded(c.expected)).length,
  }
}

// Average grade point needed across current courses to reach target CGPA.
export function requiredForTarget(grades, current, target) {
  const curCodes = new Set(current.map((c) => c.code).filter(Boolean))
  const base = gpaOf(effectiveCourses(grades).filter((c) => !curCodes.has(c.code)))
  const cur = current.filter((c) => !isNonGraded({ ...c, grade: c.expected })).reduce((s, c) => s + (Number(c.credits) || 0), 0)
  if (!cur) return { status: 'nocourses' }
  const need = (target * (base.credits + cur) - base.points) / cur
  const maxCgpa = (base.points + 10 * cur) / (base.credits + cur)
  if (need > 10) return { status: 'impossible', need, maxCgpa: round2(maxCgpa) }
  if (need <= 5) return { status: 'easy', need }
  return { status: 'ok', need, letter: letterAtLeast(need) }
}

export function letterAtLeast(gp) {
  for (const l of ['E', 'D', 'C', 'B', 'A', 'S']) if (GRADE_POINTS[l] >= gp - 1e-9) return l
  return 'S'
}

// Suggest a concrete grade mix: a uniform base letter, upgrading highest-credit courses first.
// Returns an array aligned with `current` (null for non-graded / zero-credit rows).
export function gradePlan(grades, current, target) {
  const r = requiredForTarget(grades, current, target)
  if (r.status !== 'ok') return null
  const lowerL = letterAtLeast(Math.floor(r.need))
  const upperL = letterAtLeast(Math.floor(r.need) + 1)
  const plan = current.map((c) => (Number(c.credits) > 0 && !isNonGraded({ ...c, grade: c.expected }) ? lowerL : null))
  const trial = () => project(grades, current.map((c, i) => (plan[i] ? { ...c, expected: plan[i] } : c))).cgpa
  const order = current.map((c, i) => i).filter((i) => plan[i]).sort((a, b) => current[b].credits - current[a].credits)
  for (const i of order) {
    if (trial() >= target - 1e-9) break
    plan[i] = upperL
  }
  return trial() >= target - 1e-9 ? plan : null
}

export const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '--' : Number(x).toFixed(d))
