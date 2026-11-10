# Credits and FFCS Planner

A website for VIT students that brings your VTOP academic data into one place: grades, CGPA, credits, curriculum progress and timetables. It also plans the rest of your degree and builds clash-free FFCS timetables.

- Runs on **one Cloudflare Worker**: it serves the website (`public/`) and the API (`src/worker.js`).
- Data lives in **Cloudflare D1** (SQLite). Each student has their own login, and everything they change is saved to their account.
- VTOP data comes in through a small **browser extension**, or by **copy and paste**. VTOP passwords never reach the server.

## Features

### Dashboard and grades
- **Overview:**
  - CGPA (VTOP's official figure plus a computed one), credits completed and pending, and this semester's credits
  - curriculum progress by category
  - SGPA per semester, today's classes, and courses still to clear
- **Grade history:** grouped into Fall / Winter semesters, with SGPA per semester. Repeated courses are marked as replaced.
- **Curriculum:** credits required, earned and remaining per category (Foundation Core, Discipline Core, electives, NGCR and so on).
- **Timetable:** every semester's weekly timetable (Monday to Sunday), today highlighted, and free slots between classes.

### Calculators and planners
- **GPA Calculator:** Previous, Current and Upcoming semester tabs. For each course you enter its name, credits, expected grade, and whether it's non-graded.
  - It shows expected SGPA and projected CGPA. Each tab builds on the grades from the tab before it.
  - The Previous tab fills itself from your grade history.
  - Target CGPA: the grade average you need, and a suggested grade mix.
  - Quick scenarios: All S, All A, One B.
- **CGPA Planner:** you enter the total number of semesters, the per-semester cap (27.5 by default) and any extra NPTEL / open elective credits.
  - It shows credits and semesters left, and a semester-by-semester credit plan.
  - You enter your expected SGPA for each remaining semester and see your CGPA after each one, plus your final CGPA.
  - It shows the SGPA you need for a target CGPA.
  - It has a semester-wise CGPA table.
- **Credit Planner:** for each remaining semester, how many credits to take in each curriculum category.
  - The current semester uses the courses you're registered for, matched to categories, for example "PC" to Discipline Core.
  - Later semesters get a suggested split: cores first, projects last, within the cap. Type over any number and the rest re-plans around it.
  - It shows what's left in every category after the plan, semester totals against the minimum and maximum, and what to take next semester, using courses from VTOP's allocation where available.
  - You can add custom categories, for example a minor.

### Timetable Builder (FFCS)
- **Course allocation from VTOP:** every course offered to you with its slots, faculty and venues (see *How VTOP data is fetched* below).
- **Adding subjects:** search the catalogue (code, course or faculty, plus a category filter), add courses from your own timetables, or type in new subjects with their sections.
- **Generator:** finds every clash-free choice of one section per subject.
  - **Clashes use actual class times** (day, start and end), never slot names. The slot-to-time table in `public/js/slots.js` is VTOP's own grid.
  - **Theory/lab pairing rule:** a course's theory and lab always sit in opposite halves of the day. Morning theory (ends by 13:20) goes with an evening lab (starts at 14:00 or later), and the reverse. This covers L/P pairs, and embedded courses whose theory and lab are offered as separate sections.
  - **Filters:**
    - Mixed, Morning theory, or Evening theory
    - earliest first class, latest last class
    - a specific day off, or at least one free weekday
    - most lab days a week, no weekend slots, all classes in one building
    - same faculty for theory and lab
    - avoid named faculty
  - **Ranking:** preferred faculty, then your priority order (move sections up or down), then fewer days, then fewer gaps.
  - **When nothing fits:** the clashing pairs are named, and you get the timetables that fit the most subjects.
- **Results:** shown on a VTOP-style grid, optionally grouped by slot layout, and filterable by faculty.
  - Each one can be saved, renamed, printed or saved as PDF, downloaded as CSV, shared through a read-only link, or used for the upcoming semester.
- **Showing clashes:**
  - **Pick by hand:** choose one section per subject, the way FFCS registration works. Every other section is labelled "fits", "clashes with CODE SLOT" or "same half as CODE". The grid shows time clashes in red and wrongly paired theory and lab in orange.
  - **Clash check:** how many section combinations of each pair of subjects fit together.
  - **Subjects report:** every section with a "Clashes with" column, printable as PDF or downloadable as CSV.
  - **Slot View:** click slots, and anything whose times overlap is greyed out.

### Accounts
- **Login:** email and password. Passwords are hashed with PBKDF2, sessions use HttpOnly cookies, and repeated failed logins are rate-limited.
- **Password reset by email:** sent over SMTP with a one-time link that lasts 30 minutes, at most 3 per hour. Resetting signs out every other session.
- **Your data:** download it as JSON, delete it, or delete your account.
- **Installable:** the site can be added to a phone's home screen. It uses a light theme.

## How VTOP data is fetched

VTOP rejects requests that don't come from a real browser (HTTP 403), and its login has a CAPTCHA. So the server never logs in to VTOP and never handles VTOP passwords. Data comes from the student's own logged-in browser instead:

1. **Browser extension (`extension/`):** you log in to VTOP yourself, then click **Sync from VTOP** on the dashboard. Inside your VTOP tab, the extension loads the same pages VTOP's menu does:
   - Grade History
   - Curriculum
   - the Time Table semester list, then `processViewTimeTable` for every semester
   - Course Registration Allocation, then `academics/common/getCoursesListForCurriculmCategory` per category, then `academics/common/getCoursesDetailForRegistration` per course (faculty, slot and venue)

   The raw HTML is parsed in the browser (`public/js/vtop-parser.js`), and only the extracted data is saved.

   Sub-requests must not send `verifyMenu=true`, or VTOP replies "This menu is not available at present".
2. **Copy and paste:** with no extension, select all on VTOP's Grade History or Time Table page, copy it, and paste it on the Sync page. Saving a VTOP page and uploading it also works.

**Semester rules:**
- **June to November:** current = Fall, upcoming = Winter, previous = the Winter before.
- **December to May:** current = Winter, upcoming = the next Fall, previous = the Fall before.
- **Grade history:** exams in July to December count as Fall, January to June as Winter.

## GPA rules (`public/js/calc.js`)

- **Grade points:** S=10, A=9, B=8, C=7, D=6, E=5, F/N=0. F and N count as 0 until the course is cleared.
- **Repeated courses:** the latest attempt replaces earlier ones.
- **Non-graded / NGCR courses** (grade P, or NGCR / non-graded category): their credits count as earned, but they're left out of SGPA and CGPA.

## Setup

Requirements: Node 18 or later, and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler d1 create vit-academic-dashboard     # put the printed database_id in wrangler.toml
npm run db:init:local                              # create tables in the local database
npm run dev                                        # http://localhost:8787
```

### Email for password reset (optional)

Set these as Worker secrets. For Gmail, use an App Password.

```bash
npx wrangler secret put SMTP_HOST      # e.g. smtp.gmail.com
npx wrangler secret put SMTP_PORT      # 587 (STARTTLS) or 465 (SSL)
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASS
npx wrangler secret put MAIL_FROM
```

Set `APP_URL` in `wrangler.toml` to the public site address, so reset links point to it.

For local testing, copy `.dev.vars.example` to `.dev.vars`. With `DEV_LOG_RESET_LINKS=true` and no SMTP configured, reset links are printed to the dev server log instead of emailed.

### Deploy

```bash
npm run db:init       # create tables in the remote D1 database
npm run deploy        # rebuilds the extension zip and deploys to <name>.workers.dev
```

After the first deploy, add the site's address to the extension's allowed list, so only your site can request a sync:
- `DASHBOARD_ORIGINS` in `extension/background.js`
- `content_scripts.matches` in `extension/manifest.json`

### Installing the extension

1. Download `vit-dashboard-sync.zip` from the Sync page, or zip the `extension/` folder.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click **Load unpacked** and choose the unzipped folder.

It works in Chrome, Edge and Brave on a computer.

## Project layout

```
src/worker.js            API: auth, password reset, per-user data, share links
schema.sql               D1 tables (users, sessions, academic_data, password_resets, shares, ...)
public/index.html        single-page app shell
public/js/app.js         views: overview, grades, GPA calculator, timetable, curriculum, sync, account
public/js/calc.js        CGPA / SGPA / credits rules
public/js/planner.js     CGPA Planner
public/js/creditplan.js  Credit Planner (category-wise semester plan)
public/js/builder.js     Timetable Builder UI (FFCS)
public/js/ffcs.js        timetable generator and clash checks
public/js/slots.js       VIT slot grid -> class times, pairing rule
public/js/semesters.js   Fall / Winter calendar logic
public/js/vtop-parser.js parses VTOP pages (grades, curriculum, timetables)
public/js/sync.js        talks to the extension, saves synced data
extension/               Chrome extension (Manifest V3) that reads VTOP from your logged-in tab
```

## Acknowledgements

The course-allocation fetch and the FFCS features were informed by CodeChef-VIT's open-source [FFCS-inator](https://github.com/CodeChefVIT/ffcs).
