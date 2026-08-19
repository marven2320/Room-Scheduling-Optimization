# Room Scheduling Optimization System

A client-side room scheduling and management system built for the **Department of Electrical Engineering, College of Engineering, MSU-Iligan Institute of Technology**. It uses a genetic algorithm to auto-assign rooms and time slots for classes while avoiding room, faculty, and regular-student scheduling conflicts — with no backend, no build step, and no data ever leaving your browser.

## Features

- **Rooms** — weekly availability grids (30-minute slots, 7:30 AM–9:00 PM), custom per-room hours, CSV import/export.
- **Subjects** — Lecture/Laboratory types, configurable duration & sessions/week, 3-hour Lecture split into paired 1.5h sessions, Laboratory capacity-split sections, **External Assignment** (for subjects handled by another college — room shows TBA, faculty TBD).
- **Faculty** — assign handled subjects; the optimizer never double-books a faculty member across rooms.
- **Prospectus** — upload one or more degree programs' curricula (CSV or best-effort PDF parsing), with automatic duplicate detection and a review step before saving.
- **Target Semester** — pick a real term (First/Second Semester, Summer Term) to auto-load every uploaded program's courses for that term, and enable regular-student conflict-checking — kept independent per program *and* year level, so a 4-year program's term runs 4 cohorts at once without them blocking each other.
- **Optimizer** — a genetic algorithm (tournament selection, order crossover, swap mutation) that auto-scales population/generations to problem complexity, with a live convergence progress modal. Anything that can't be placed is separated into Room / Faculty / Regular-Student conflict groups with specific, actionable reasons.
- **Schedule views** — Room Timetable, Faculty Schedule (per faculty member), Regular-Student Schedule (per program/year-level cohort), and a flat List View — each printable and exportable to CSV on its own.
- **Guide tab** — an in-app step-by-step walkthrough and FAQ.

## Running it

No build step, no dependencies to install. Serve the folder with any static file server, e.g.:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Opening `index.html` directly from disk also works for most features; a local server avoids browser file:// restrictions.)

The only external network call the app makes is a one-time fetch of [pdf.js](https://mozilla.github.io/pdf.js/) from a public CDN, and only if you use the "Upload PDF" prospectus feature — everything else runs entirely offline, and all data is stored in your browser's `localStorage`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup for every tab |
| `styles.css` | Maroon/white theme, layout, print styles |
| `app.js` | All application logic (state, rendering, the genetic algorithm) |
| `prospectus-pdf.js` | Standalone PDF-prospectus parser (lazy-loads pdf.js) |
| `msuiit-logo.png` | MSU-IIT seal, used in the header |
| `BSEE_Prospectus_2018_rev.{pdf,csv}` | Sample prospectus data used during development |

## Bug reports

Visit the [Department of Electrical Engineering (DEE)](https://dee.msuiit.edu.ph) website.
