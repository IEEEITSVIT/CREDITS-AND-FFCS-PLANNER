// Parses VTOP pages (Grade History, Timetable, Curriculum) from raw HTML into structured data.
// Runs in the browser; DOMParser never executes scripts, and we only read text content.

const COURSE_CODE = /\b([A-Z]{3,4}\s?\d{3,4}[A-Z]?)\b/
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const num = (s) => {
  const m = String(s || '').match(/-?\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

// Cell text with spaces between block pieces: VTOP often writes "<p>3</p><p>0</p>..." or
// "<p>A1+TA1 -</p><p>SJT301</p>", which plain textContent would glue together.
const BLOCK = new Set(['P', 'DIV', 'BR', 'LI', 'TD', 'TH', 'TR', 'TABLE', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
function cellText(el) {
  let out = ''
  const walk = (n) => {
    if (n.nodeType === 3) { out += n.data; return }
    if (n.nodeType !== 1) return
    const tag = n.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SELECT' || tag === 'OPTION') return
    if (tag === 'INPUT') { if (n.type !== 'hidden' && n.value) out += ' ' + n.value + ' '; return }
    const block = BLOCK.has(tag)
    if (block) out += ' '
    for (const c of n.childNodes) walk(c)
    if (block) out += ' '
  }
  walk(el)
  return clean(out)
}

// Expand a <table> into a rectangular grid of cell text, honouring rowspan/colspan.
function tableGrid(table) {
  const grid = []
  const rows = [...table.rows]
  rows.forEach((tr, r) => {
    grid[r] = grid[r] || []
    let c = 0
    for (const cell of tr.cells) {
      while (grid[r][c] !== undefined) c++
      const text = cellText(cell)
      const rs = Math.min(parseInt(cell.getAttribute('rowspan') || '1', 10) || 1, 50)
      const cs = Math.min(parseInt(cell.getAttribute('colspan') || '1', 10) || 1, 50)
      for (let i = 0; i < rs; i++) {
        grid[r + i] = grid[r + i] || []
        for (let j = 0; j < cs; j++) grid[r + i][c + j] = text
      }
      c += cs
    }
  })
  return grid.map((row) => [...row].map((x) => x ?? ''))
}

// Own tables only (not ones nested inside a cell), to avoid double counting.
function leafTables(doc) {
  return [...doc.querySelectorAll('table')]
}

// Find a header row and map field -> column index. spec: {field: [matchers]}; matcher is a
// normalised string matched exactly first, then as a prefix/substring.
function findHeader(grid, spec, required, maxScan = 15) {
  for (let r = 0; r < Math.min(grid.length, maxScan); r++) {
    const cells = grid[r].map(norm)
    const map = {}
    for (const [field, keys] of Object.entries(spec)) {
      let idx = cells.findIndex((c) => keys.includes(c))
      if (idx < 0) idx = cells.findIndex((c) => keys.some((k) => c.startsWith(k)))
      if (idx < 0) idx = cells.findIndex((c) => keys.some((k) => k.length > 4 && c.includes(k)))
      if (idx >= 0) map[field] = idx
    }
    if (required.every((f) => f in map)) return { row: r, map }
  }
  return null
}

function parseGrades(grid) {
  const h = findHeader(
    grid,
    {
      code: ['coursecode'],
      title: ['coursetitle', 'coursename', 'title'],
      type: ['coursetype'],
      credits: ['credits', 'credit'],
      grade: ['grade', 'finalgrade'],
      exam: ['exammonth', 'examheld', 'month', 'examination'],
      distribution: ['coursedistribution', 'distribution', 'category'],
    },
    ['code', 'credits', 'grade']
  )
  if (!h) return []
  const out = []
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r]
    const codeCell = row[h.map.code] || ''
    const m = codeCell.match(COURSE_CODE)
    if (!m || clean(codeCell).length > 14) continue
    const grade = clean(row[h.map.grade]).toUpperCase().split(' ')[0]
    const credits = num(row[h.map.credits])
    if (!grade || credits === null) continue
    out.push({
      code: m[1].replace(/\s/g, ''),
      title: clean(row[h.map.title] ?? ''),
      type: clean(row[h.map.type] ?? ''),
      credits,
      grade,
      examMonth: clean(row[h.map.exam] ?? ''),
      distribution: clean(row[h.map.distribution] ?? ''),
    })
  }
  return out
}

function parseSummary(grid) {
  const h = findHeader(
    grid,
    { registered: ['creditsregistered'], earned: ['creditsearned', 'earnedcredits'], cgpa: ['cgpa'] },
    ['earned', 'cgpa']
  )
  if (!h) return null
  const row = grid[h.row + 1]
  if (!row) return null
  const cgpa = num(row[h.map.cgpa])
  if (cgpa === null || cgpa > 10) return null
  return {
    creditsRegistered: h.map.registered !== undefined ? num(row[h.map.registered]) : null,
    creditsEarned: num(row[h.map.earned]),
    cgpa,
  }
}

function parseCurriculum(grid) {
  const h = findHeader(
    grid,
    {
      name: ['baskettitle', 'basket', 'category', 'curriculumdistributiontype', 'distributiontype', 'coursecategory', 'type'],
      required: ['creditsrequired', 'requiredcredits', 'required', 'mincredits', 'minimumcredits'],
      earned: ['creditsearned', 'earnedcredits', 'earned'],
    },
    ['name', 'required', 'earned']
  )
  if (!h) return null
  const categories = []
  let totalRequired = null
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r]
    const name = clean(row[h.map.name])
    const required = num(row[h.map.required])
    const earned = num(row[h.map.earned])
    if (!name || required === null) continue
    if (/total/i.test(name)) {
      totalRequired = required
      continue
    }
    categories.push({ name, required, earned: earned ?? 0 })
  }
  if (!categories.length) return null
  if (totalRequired === null) totalRequired = categories.reduce((s, c) => s + c.required, 0)
  return { categories, totalRequired }
}

function parseCourseList(grid) {
  const h = findHeader(
    grid,
    {
      code: ['coursecode'],
      course: ['course', 'coursedetail', 'coursetitle'],
      ltpjc: ['ltpjc', 'credits', 'credit'],
      slot: ['slotvenue', 'slot'],
      venue: ['venue'],
      faculty: ['facultydetails', 'faculty', 'facultyname'],
      category: ['category', 'coursetype'],
    },
    ['slot', 'faculty']
  )
  if (!h || (h.map.course === undefined && h.map.code === undefined)) return []
  const byCode = new Map()
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r]
    const courseText = clean(row[h.map.course ?? h.map.code])
    const codeText = h.map.code !== undefined ? clean(row[h.map.code]) : courseText
    const m = codeText.match(COURSE_CODE)
    if (!m) continue
    const code = m[1].replace(/\s/g, '')
    // "CSE1001 - Problem Solving and Programming - Embedded Theory" or "(Embedded Theory)"
    let title = courseText.replace(m[0], '').replace(/^\s*[-:]\s*/, '')
    let type = ''
    const paren = title.match(/\(([^)]+)\)\s*$/)
    if (paren) {
      type = paren[1]
      title = title.slice(0, paren.index)
    } else {
      const parts = title.split(/\s+-\s+/)
      if (parts.length > 1 && /theory|lab|project|soft|online/i.test(parts[parts.length - 1])) type = parts.pop()
      title = parts.join(' - ')
    }
    const nums = (clean(row[h.map.ltpjc]).match(/\d+(\.\d+)?/g) || []).map(Number)
    const credits = nums.length ? nums[nums.length - 1] : 0
    const slotText = clean(row[h.map.slot])
    let [slot, venue] = slotText.split(/\s+-\s+/)
    if (h.map.venue !== undefined && h.map.venue !== h.map.slot) venue = clean(row[h.map.venue])
    const faculty = clean(row[h.map.faculty]).split(/\s+-\s+/)[0]
    const prev = byCode.get(code)
    if (prev) {
      prev.credits += credits
      prev.slot = [prev.slot, slot].filter(Boolean).join(' + ')
      prev.venue = [...new Set([prev.venue, venue].filter(Boolean))].join(', ')
      if (type && !prev.type.includes(type)) prev.type = [prev.type, type].filter(Boolean).join(' + ')
    } else {
      byCode.set(code, {
        code,
        title: clean(title),
        type: clean(type),
        credits,
        slot: clean(slot || ''),
        venue: clean(venue || ''),
        faculty,
        category: clean(row[h.map.category] ?? ''),
        expected: '',
      })
    }
  }
  return [...byCode.values()].filter((c) => c.code)
}

// Backup when column headers aren't recognised: a row with "CODE - Title", an "L T P J C" cell
// (five numbers) and a "SLOT - VENUE" cell is a registered course.
const CODE_TITLE = /^([A-Z]{3,5}\s?\d{3,4}[A-Z]?)\s*-\s*(.+)$/
const LTPJC = /^(\d+(\.\d+)?\s+){4}\d+(\.\d+)?$/
const SLOT_VENUE = /^([A-Z]{1,4}\d{1,3}(\s*\+\s*[A-Z]{1,4}\d{1,3})*)\s*-\s*(\S.*)$/
function parseCourseListLoose(grid) {
  const byCode = new Map()
  for (const row of grid) {
    const ci = row.findIndex((c) => CODE_TITLE.test(c))
    const li = row.findIndex((c) => LTPJC.test(c))
    const si = row.findIndex((c, i) => i !== ci && SLOT_VENUE.test(c))
    if (ci < 0 || li < 0 || si < 0) continue
    const [, rawCode, rest] = row[ci].match(CODE_TITLE)
    const code = rawCode.replace(/\s/g, '')
    let title = rest, type = ''
    const paren = rest.match(/\(([^)]+)\)\s*$/)
    if (paren) { type = clean(paren[1]); title = rest.slice(0, paren.index) }
    else { const parts = rest.split(/\s+-\s+/); if (parts.length > 1 && /theory|lab|project|soft|online/i.test(parts[parts.length - 1])) type = parts.pop(); title = parts.join(' - ') }
    const nums = row[li].match(/\d+(\.\d+)?/g).map(Number)
    const credits = nums[nums.length - 1]
    const sm = row[si].match(SLOT_VENUE)
    const faculty = clean((row.slice(si + 1).find((c) => /[A-Za-z]{3,}/.test(c) && !SLOT_VENUE.test(c)) || '').split(/\s+-\s+/)[0])
    const prev = byCode.get(code)
    if (prev) {
      prev.credits += credits
      prev.slot = [prev.slot, sm[1]].filter(Boolean).join(' + ')
      prev.venue = [...new Set([prev.venue, sm[3]].filter(Boolean))].join(', ')
      if (type && !prev.type.includes(type)) prev.type = [prev.type, type].filter(Boolean).join(' + ')
    } else byCode.set(code, { code, title: clean(title), type, credits, slot: clean(sm[1]).replace(/\s+/g, ''), venue: clean(sm[3]), faculty, category: '', expected: '' })
  }
  return [...byCode.values()]
}

export function toMinutes(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const ap = (m[3] || '').toUpperCase()
  if (ap === 'PM' && h < 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  if (!ap && h < 7) h += 12 // VTOP sometimes prints 1:00 for 13:00
  return h * 60 + min
}

function parseTimetableGrid(grid) {
  const starts = {}
  const ends = {}
  const dayRows = []
  for (const row of grid) {
    const head = row.slice(0, 3).map((c) => c.toUpperCase())
    const kind = head.find((c) => c === 'THEORY' || c === 'LAB')
    const day = head.map((c) => c.slice(0, 3)).find((c) => DAYS.includes(c))
    if (kind && head.some((c) => c === 'START')) starts[kind] = row
    else if (kind && head.some((c) => c === 'END')) ends[kind] = row
    else if (day && kind) dayRows.push({ day, kind, row })
  }
  if (!dayRows.length || !Object.keys(starts).length) return null

  const entries = []
  for (const { day, kind, row } of dayRows) {
    const st = starts[kind] || starts.THEORY
    const en = ends[kind] || ends.THEORY
    let last = null
    for (let j = 1; j < row.length; j++) {
      const cell = row[j]
      if (!cell || !cell.includes('-')) {
        last = null
        continue
      }
      const parts = cell.split('-').map(clean)
      const codeIdx = parts.findIndex((p) => /^[A-Z]{3,4}\d{3,4}[A-Z]?$/.test(p))
      if (codeIdx < 0) {
        last = null
        continue
      }
      const code = parts[codeIdx]
      const entry = {
        day,
        kind: kind === 'LAB' ? 'Lab' : 'Theory',
        slot: parts[0],
        code,
        courseType: parts[codeIdx + 1] || '',
        venue: parts[codeIdx + 2] || '',
        start: st?.[j] || '',
        end: en?.[j] || '',
        col: j,
      }
      // Merge consecutive lab slots (L31 + L32) into one block.
      if (last && last.code === code && last.col === j - 1) {
        last.end = entry.end
        last.slot += '+' + entry.slot
        last.col = j
        continue
      }
      entries.push(entry)
      last = entry
    }
  }
  if (!entries.length) return null
  return {
    entries: entries
      .filter((e) => toMinutes(e.start) !== null)
      .map(({ col, ...e }) => e)
      .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || toMinutes(a.start) - toMinutes(b.start)),
  }
}

function parseProfile(doc) {
  const text = clean(doc.body?.innerText ?? doc.body?.textContent ?? '')
  const reg = text.match(/(?<![\dA-Z])(\d{2}[A-Z]{3}\d{4})(?!\d)/)
  return reg ? { regNo: reg[1] } : null
}

// Main entry: HTML string -> {grades, summary, curriculum, current, timetable, profile} (only what was found).
export function parseVtopHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const result = {}
  const grades = []
  let looseCourses = []
  const seen = new Set()

  for (const table of leafTables(doc)) {
    const grid = tableGrid(table)
    if (grid.length < 2) continue

    for (const g of parseGrades(grid)) {
      const key = `${g.code}|${g.examMonth}|${g.grade}`
      if (!seen.has(key)) {
        seen.add(key)
        grades.push(g)
      }
    }
    if (!result.summary) {
      const s = parseSummary(grid)
      if (s) result.summary = s
    }
    if (!result.curriculum) {
      const c = parseCurriculum(grid)
      if (c) result.curriculum = c
    }
    if (!result.current) {
      const cl = parseCourseList(grid)
      if (cl.length) result.current = cl
    }
    if (!result.current && !looseCourses.length) looseCourses = parseCourseListLoose(grid)
    if (!result.timetable) {
      const tt = parseTimetableGrid(grid)
      if (tt) result.timetable = tt
    }
  }
  if (!result.current && looseCourses.length) result.current = looseCourses
  if (grades.length) result.grades = grades
  if (result.timetable && result.current) {
    const titles = Object.fromEntries(result.current.map((c) => [c.code, c.title]))
    result.timetable.entries.forEach((e) => (e.title = titles[e.code] || ''))
  }
  // Which semester a timetable page is for, only when the page marks the selected option.
  const sel = doc.querySelector('select#semesterSubId, select[name="semesterSubId"]')
  const opt = sel?.querySelector('option[selected]')
  if (opt?.value && (result.current || result.timetable)) result.semester = { id: opt.value.trim(), name: clean(opt.textContent) }
  const profile = parseProfile(doc)
  if (profile && Object.keys(result).length) result.profile = profile
  return result
}

// Copied table text (tab separated) -> HTML table string, so it can go through the same parser.
export function tsvToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => '<tr>' + l.split('\t').map((c) => `<td>${esc(c)}</td>`).join('') + '</tr>')
  return `<table>${rows.join('')}</table>`
}
