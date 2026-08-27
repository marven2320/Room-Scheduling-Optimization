# Room Scheduling Optimization System

A room scheduling and management system built for the **Department of Electrical Engineering, College of Engineering, MSU-Iligan Institute of Technology**. It uses a genetic algorithm to auto-assign rooms and time slots for classes while avoiding room, faculty, and regular-student scheduling conflicts. The app itself is fully client-side (no build step, all scheduling data stays in your browser's `localStorage`); an optional local server adds app-usage monitoring for testing purposes — see [Running it](#running-it).

## Features

- **Rooms** — weekly availability grids (30-minute slots, 7:30 AM–9:00 PM), custom per-room hours, an **Allowable Usage %** cap for rooms shared with other departments, manually-set **Priority Subjects** per room (e.g. keep a specialized lab for its equipment-matched subjects — a soft preference, not exclusive), CSV import/export.
- **Subjects** — Lecture/Laboratory types, configurable duration & sessions/week, 3-hour Lecture split into paired 1.5h sessions, Laboratory capacity-split sections, **External Assignment** (for subjects handled by another college — room shows TBA, faculty TBD).
- **Faculty** — assign handled subjects; the optimizer never double-books a faculty member across rooms.
- **Prospectus** — upload one or more degree programs' curricula (CSV or best-effort PDF parsing), or add courses one at a time with the **Add a Course Manually** input block (no file needed) — each program gets its own block in the list, with a "+ Add Course" shortcut to top it up by hand. Automatic duplicate detection (Program + Year + Term + Code) and a review step before saving apply to every entry path alike.
- **Target Semester** — pick a real term (First/Second Semester, Summer Term) to auto-load every uploaded program's courses for that term, and enable regular-student conflict-checking — kept independent per program *and* year level, so a 4-year program's term runs 4 cohorts at once without them blocking each other.
- **Fixed Schedule** — import sessions already decided ahead of time (CSV) and the optimizer treats them as hard constraints: locked in place before anything new is scheduled, blocking room/faculty/cohort conflicts against them exactly like a newly-placed session would. "📌 Export for Fixed Schedule" on an optimized result produces a file that imports straight back in — a completed schedule becomes next semester's starting point with no reformatting.
- **Optimizer** — a genetic algorithm (tournament selection, order crossover, swap mutation) that auto-scales population/generations to problem complexity, with a live convergence progress modal. Enforces room/faculty/regular-student/shared-room-usage/room-type/fixed-schedule constraints and prefers each room's manually-set Priority Subjects; anything that can't be placed is separated into Room / Faculty / Regular-Student conflict groups with specific, actionable reasons.
- **Number of Blocks** (Optimize Schedule tab) — how many parallel, independently-scheduled sections to generate, set *per program* based on what's uploaded in the Prospectus tab (a program with 2 intake sections can differ from one with just 1), plus a Default for subjects with no prospectus link.
- **Schedule views** — Room Timetable, Faculty Schedule (per faculty member), Regular-Student Schedule (per program/year-level cohort), and a flat List View — each printable and exportable to CSV on its own.
- **Guide tab** — an in-app step-by-step walkthrough and FAQ.
- **App Usage Summary tab** — visitor counts, function-usage charts, optimizer generations/population history, network latency, and error reports — read from `server.py`'s usage log (see below).

## Running it

**Option A — plain static server (no usage tracking):**

```bash
python3 -m http.server 8000
```

**Option B — `server.py` (recommended; adds the App Usage Summary tab):**

```bash
python3 server.py 8000
```

Either way, open `http://localhost:8000`. Both are pure Python standard library — nothing to install.

`server.py` serves the exact same static files as Option A, plus two small JSON endpoints (`POST /api/track`, `GET /api/usage-data`) that log basic usage activity — timestamp, visitor IP, which feature was used, optimizer generations/population size, network latency, and any app errors — to `usage_log.csv` in the project folder, for app-functionality testing. **This records real visitor IP addresses.** Before pointing it at real end users, disclose that access is logged (the in-app footer and Guide tab already do this) and keep `usage_log.csv` restricted to people who should see raw IPs. The app works identically either way — tracking never blocks or slows down any actual scheduling feature, and silently does nothing if the endpoint isn't there.

The only other external network call the app makes is a one-time fetch of [pdf.js](https://mozilla.github.io/pdf.js/) from a public CDN, and only if you use the "Upload PDF" prospectus feature — everything else runs entirely offline.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup for every tab |
| `styles.css` | Maroon/white theme, layout, print styles |
| `app.js` | All application logic (state, rendering, the genetic algorithm) |
| `prospectus-pdf.js` | Standalone PDF-prospectus parser (lazy-loads pdf.js) |
| `server.py` | Optional local server: static file serving + usage-tracking API (see above) |
| `usage_log.csv` | Usage-tracking log written by `server.py` (created on first run; not committed) |
| `msuiit-logo.png` | MSU-IIT seal, used in the header |
| `BSEE_Prospectus_2018_rev.{pdf,csv}` | Sample prospectus data used during development |

## Bug reports

Visit the [Department of Electrical Engineering (DEE)](https://dee.msuiit.edu.ph) website.
