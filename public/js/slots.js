// VIT Vellore FFCS slot grid (from the VTOP timetable page). Slots don't change between
// semesters; only courses and faculty do. Each slot maps to the days/times it meets.

const THEORY_TIMES = [
  ['08:00', '08:50'], ['09:00', '09:50'], ['10:00', '10:50'], ['11:00', '11:50'], ['12:00', '12:50'], null,
  ['14:00', '14:50'], ['15:00', '15:50'], ['16:00', '16:50'], ['17:00', '17:50'], ['18:00', '18:50'], ['18:51', '19:00'], ['19:01', '19:50'],
]
const LAB_TIMES = [
  ['08:00', '08:50'], ['08:51', '09:40'], ['09:51', '10:40'], ['10:41', '11:30'], ['11:40', '12:30'], ['12:31', '13:20'],
  ['14:00', '14:50'], ['14:51', '15:40'], ['15:51', '16:40'], ['16:41', '17:30'], ['17:40', '18:30'], ['18:31', '19:20'], null,
]
// Columns per day (lunch column dropped). '-' = no slot.
const THEORY_GRID = {
  MON: ['A1', 'F1', 'D1', 'TB1', 'TG1', '-', 'A2', 'F2', 'D2', 'TB2', 'TG2', '-', 'V3'],
  TUE: ['B1', 'G1', 'E1', 'TC1', 'TAA1', '-', 'B2', 'G2', 'E2', 'TC2', 'TAA2', '-', 'V4'],
  WED: ['C1', 'A1', 'F1', 'V1', 'V2', '-', 'C2', 'A2', 'F2', 'TD2', 'TBB2', '-', 'V5'],
  THU: ['D1', 'B1', 'G1', 'TE1', 'TCC1', '-', 'D2', 'B2', 'G2', 'TE2', 'TCC2', '-', 'V6'],
  FRI: ['E1', 'C1', 'TA1', 'TF1', 'TD1', '-', 'E2', 'C2', 'TA2', 'TF2', 'TDD2', '-', 'V7'],
  SAT: ['V8', 'X11', 'X12', 'Y11', 'Y12', '-', 'X21', 'Z21', 'Y21', 'W21', 'W22', '-', 'V9'],
  SUN: ['V10', 'Y11', 'Y12', 'X11', 'X12', '-', 'Y21', 'Z21', 'X21', 'W21', 'W22', '-', 'V11'],
}
const LAB_START = { MON: 1, TUE: 7, WED: 13, THU: 19, FRI: 25, SAT: 71, SUN: 83 }
const LAB_AFTERNOON = { MON: 31, TUE: 37, WED: 43, THU: 49, FRI: 55, SAT: 77, SUN: 89 }

export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
export const LUNCH_START = 13 * 60 + 20 // 13:20
export const AFTERNOON_START = 14 * 60

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }

// slot -> [{day, start, end, kind}]
export const SLOT_MAP = (() => {
  const map = {}
  const add = (slot, day, [s, e], kind) => (map[slot] = map[slot] || []).push({ day, start: s, end: e, s: toMin(s), e: toMin(e), kind })
  for (const day of DAYS) {
    THEORY_GRID[day].forEach((slot, i) => { if (slot !== '-' && THEORY_TIMES[i]) add(slot, day, THEORY_TIMES[i], 'Theory') })
    for (let i = 0; i < 6; i++) add(`L${LAB_START[day] + i}`, day, LAB_TIMES[i], 'Lab')
    for (let i = 0; i < 6; i++) if (LAB_TIMES[6 + i]) add(`L${LAB_AFTERNOON[day] + i}`, day, LAB_TIMES[6 + i], 'Lab')
  }
  return map
})()

export const normSlot = (s) => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/_+/g, '+')

// "B1+TB1" -> meetings; unknown slot names are reported separately.
export function slotMeetings(slotStr) {
  const parts = normSlot(slotStr).split('+').filter(Boolean)
  const meetings = [], unknown = []
  for (const p of parts) {
    if (p === 'NIL') continue
    if (SLOT_MAP[p]) meetings.push(...SLOT_MAP[p].map((m) => ({ ...m, slot: p })))
    else unknown.push(p)
  }
  return { meetings, unknown }
}

export const isValidSlot = (slotStr) => {
  const { meetings, unknown } = slotMeetings(slotStr)
  return !unknown.length && (meetings.length > 0 || normSlot(slotStr) === 'NIL')
}

export function meetingsClash(a, b) {
  for (const x of a) for (const y of b) if (x.day === y.day && x.s < y.e && y.s < x.e) return true
  return false
}

// Morning ('M') = before lunch, evening ('E') = after lunch, 'X' = spans both (e.g. TF1+TF2).
export function halfOf(meetings) {
  if (!meetings.length) return null
  if (meetings.every((m) => m.e <= LUNCH_START)) return 'M'
  if (meetings.every((m) => m.s >= AFTERNOON_START)) return 'E'
  return 'X'
}
export const theoryOf = (meetings) => meetings.filter((m) => m.kind === 'Theory')
export const labOf = (meetings) => meetings.filter((m) => m.kind === 'Lab')

// VIT pairing rule: a course's theory and lab sit in opposite halves of the day.
// Morning theory -> evening lab; evening theory -> morning lab. Returns false if they're in the same half.
export function pairOk(theoryMeetings, labMeetings) {
  const t = halfOf(theoryMeetings), l = halfOf(labMeetings)
  if (!t || !l || t === 'X' || l === 'X') return true
  return t !== l
}

// Filters: 'mixed' (any), 'morning' = morning theory + evening lab, 'afternoon' = evening theory + morning lab.
export function fitsFilter(meetings, filter, avoidWeekend) {
  if (avoidWeekend && meetings.some((m) => m.day === 'SAT' || m.day === 'SUN')) return false
  const th = theoryOf(meetings), lab = labOf(meetings)
  if (filter === 'morning') return th.every((m) => m.e <= LUNCH_START) && lab.every((m) => m.s >= AFTERNOON_START)
  if (filter === 'afternoon') return th.every((m) => m.s >= AFTERNOON_START) && lab.every((m) => m.e <= LUNCH_START)
  return true
}

// ---- Grid layout (same shape as VTOP's timetable) ----
// 13 slot columns per row; lunch sits between column 5 and 6.
export const GRID = {
  theoryTimes: THEORY_TIMES,
  labTimes: LAB_TIMES,
  rows: DAYS.map((day) => ({
    day,
    theory: THEORY_GRID[day],
    lab: Array.from({ length: 13 }, (_, i) => (i < 6 ? `L${LAB_START[day] + i}` : i < 12 ? `L${LAB_AFTERNOON[day] + i - 6}` : '-')),
  })),
}
export const splitSlots = (slotStr) => normSlot(slotStr).split('+').filter((x) => x && x !== 'NIL')
