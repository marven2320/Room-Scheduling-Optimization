(function(){
"use strict";

/* ---------------------------------------------------------------------
   CONSTANTS
--------------------------------------------------------------------- */
const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const DAY_FULL = {Mon:"Monday",Tue:"Tuesday",Wed:"Wednesday",Thu:"Thursday",Fri:"Friday",Sat:"Saturday",Sun:"Sunday"};
const START_MIN = 7*60+30;   // 7:30 AM — hard outer bound; no room can open earlier
const END_MIN   = 21*60;     // 9:00 PM — hard outer bound; no room can stay open later
const SLOT_LEN  = 30;        // minutes
const SLOT_TIMES = (function(){
  const arr=[];
  for(let t=START_MIN;t<END_MIN;t+=SLOT_LEN) arr.push(t);
  return arr;
})();
const NUM_SLOTS = SLOT_TIMES.length; // 27

// Every room defaults to open the full 7:30 AM–9:00 PM window unless custom hours are
// specified — which can only narrow that window (later open, earlier close), never widen
// it past these same outer bounds, at creation or later via "Edit Availability".
const DEFAULT_OPEN_MIN = START_MIN;
const DEFAULT_CLOSE_MIN = END_MIN;

const COLORS = ["#7a1f33","#4a5568","#b3791f","#3d6b4f","#6b3fa0","#8c2f45","#2f6690",
                "#a0522d","#5a6b1f","#9c4a6a","#3a4a5c","#b0651f","#4a7a6b","#6b2f4a"];

// Preferred paired-day combinations for split 3-hour subjects (1.5h x2), in priority order.
// Listing FSa (Fri/Sat) last means the AUTO picker only reaches for a Friday-anchored pair
// once Mon/Wed and Tue/Thu are unavailable — the split-pair half of the Friday energy-saving
// preference (constraint #4); the "single"-task placement path applies the rest.
const DAY_PAIRS = { MW:["Mon","Wed"], TTh:["Tue","Thu"], FSa:["Fri","Sat"] };
const DAY_PAIR_ORDER = ["MW","TTh","FSa"];
const DAY_PAIR_LABELS = { AUTO:"Auto (best available)", MW:"Mon & Wed", TTh:"Tue & Thu", FSa:"Fri & Sat" };

// No subject may be scheduled on Sunday except these two course codes (NSTP, which
// conventionally meets on Sundays) — constraint #1. Matched against a linked prospectus
// course's code, or the subject's own name as a fallback for manually-added subjects.
const SUNDAY_EXEMPT_CODES = ["NST001","NST002"];
const NON_SUNDAY_DAYS = DAYS.filter(d=> d!=="Sun");

// Sentinel "room" for External-Assignment subjects — no real room is booked (handled by
// another college/department), so these get a placeholder id/name instead of a real roomId,
// and are excluded from room double-booking checks (multiple external subjects legitimately
// can share the same day/time since none of them occupy a physical room).
const TBA_ROOM_ID = "__TBA__";
const TBA_ROOM_NAME = "TBA / External (No Room)";

// The Target Semester picker is always exactly these 3 real-world terms — selecting one
// loads every uploaded program's courses for that term at once (see autoPopulateSubjectsForTerm),
// so multiple degree programs can be scheduled together in one optimization run.
const PROSPECTUS_TERMS = ["First Semester", "Second Semester", "Summer Term"];

// Canonicalizes a Term value coming from CSV/PDF import into exactly one of PROSPECTUS_TERMS
// whenever it's a recognizable variant (different casing, "1st"/"2nd" instead of
// "First"/"Second", stray whitespace, "Summer" alone, etc.) — Target Semester selection and
// cohort grouping both compare terms with strict equality, so a course whose Term didn't
// exactly match one of the 3 fixed strings would otherwise never be found by either, with no
// error to explain why. Returns the trimmed original text unchanged if nothing recognizable
// matches, so unrecognized values are still visible in the Prospectus list rather than lost.
function normalizeTermValue(raw){
  const s = String(raw||"").trim().replace(/\s+/g, " ");
  const low = s.toLowerCase();
  if(/^(first|1st)\b/.test(low) && /semester/.test(low)) return "First Semester";
  if(/^(second|2nd)\b/.test(low) && /semester/.test(low)) return "Second Semester";
  if(/summer/.test(low)) return "Summer Term";
  return s;
}

function fmtTime(mins){
  let h = Math.floor(mins/60), m = mins%60;
  const ampm = h>=12 ? "PM":"AM";
  let h12 = h%12; if(h12===0) h12=12;
  return h12+":"+(m<10?"0"+m:m)+" "+ampm;
}
function slotLabel(i){ return fmtTime(SLOT_TIMES[i]); }
function genId(prefix){ return prefix+"_"+Math.random().toString(36).slice(2,9)+Date.now().toString(36); }
// Builds a fresh weekly availability grid. With no arguments, every day is open for the
// full 7:30 AM–9:00 PM window. Pass openMin/closeMin (minutes from midnight) to open a room
// for a narrower custom range within those same fixed outer bounds instead — a room can
// never open earlier than 7:30 AM or stay open later than 9:00 PM.
function makeAvailability(openMin, closeMin){
  const from = openMin==null ? DEFAULT_OPEN_MIN : openMin;
  const to = closeMin==null ? DEFAULT_CLOSE_MIN : closeMin;
  const av={};
  DAYS.forEach(d=> av[d] = SLOT_TIMES.map(t => t>=from && t<to));
  return av;
}

/* ---------------------------------------------------------------------
   STATE
--------------------------------------------------------------------- */
let state = {
  rooms: [],
  subjects: [],
  faculty: [], // [{id, name, subjectIds:[...]}]
  prospectus: [], // [{id, year, yearLabel, term, code, title, units, lec, lab}]
  targetTerm: "", // "<yearLabel>|<term>" — the regular-student cohort the optimizer keeps conflict-free
  blocks: 1, // Number of Blocks (Optimize Schedule tab) — multiplies every subject into this many independent sections
  schedule: null // {assignments:[...], unscheduled:[...], stats:{...}}
};

function saveState(){
  try{ localStorage.setItem("rms_state_v1", JSON.stringify(state)); }catch(e){ /* ignore quota errors */ }
}
// Room availability arrays saved under a different slot grid (either this app's original
// fixed 7:30 AM–9:00 PM window, or a briefly-wider 6:00 AM–11:00 PM window) are the wrong
// length for the current grid and would misalign if used as-is. Rebuild them at the current
// slot indices, keyed by actual clock time (not raw index), so every open/closed half-hour
// that's still within 7:30 AM–9:00 PM lands exactly where it did before. Anything that was
// open only outside that window (e.g. 6:00–7:30 AM) can no longer be represented and is
// dropped — those hours are no longer allowed for any room.
function migrateLegacyAvailability(room){
  const currentLen = room.availability && room.availability.Mon ? room.availability.Mon.length : NUM_SLOTS;
  if(currentLen === NUM_SLOTS) return false; // already the current shape, nothing to do
  // Infer the old grid's bounds from its slot count: 27 = the original 7:30 AM–9:00 PM
  // window, 34 = the briefly-wider 6:00 AM–11:00 PM window. Anything else falls back to
  // assuming it started at the current START_MIN (best effort for unexpected sizes).
  const oldStart = currentLen === 34 ? 6*60 : START_MIN;
  const oldSlotTimes = [];
  for(let i=0;i<currentLen;i++) oldSlotTimes.push(oldStart + i*SLOT_LEN);
  const migrated = {};
  DAYS.forEach(d=>{
    const oldArr = (room.availability && room.availability[d]) || [];
    const newArr = new Array(NUM_SLOTS).fill(false);
    oldArr.forEach((wasOpen, i)=>{
      if(!wasOpen) return;
      const clockTime = oldSlotTimes[i];
      const newIdx = SLOT_TIMES.indexOf(clockTime);
      if(newIdx>=0) newArr[newIdx] = true; // silently clamped away if outside 7:30 AM–9:00 PM
    });
    migrated[d] = newArr;
  });
  room.availability = migrated;
  return true;
}

function loadState(){
  try{
    const raw = localStorage.getItem("rms_state_v1");
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && typeof parsed === "object"){
        state.rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
        state.subjects = Array.isArray(parsed.subjects) ? parsed.subjects : [];
        state.faculty = Array.isArray(parsed.faculty) ? parsed.faculty : [];
        state.prospectus = Array.isArray(parsed.prospectus) ? parsed.prospectus : [];
        state.targetTerm = typeof parsed.targetTerm === "string" ? parsed.targetTerm : "";
        state.blocks = Number.isFinite(parsed.blocks) && parsed.blocks>=1 ? Math.round(parsed.blocks) : 1;
        state.schedule = parsed.schedule || null;

        let migratedAny = false;
        state.rooms.forEach(r=>{ if(migrateLegacyAvailability(r)) migratedAny = true; });
        if(migratedAny){
          // Slot indices shifted, so any saved schedule's startSlot values no longer point
          // at the right times — clear it rather than show a silently-wrong timetable. It's
          // just re-generated by clicking Optimize again.
          state.schedule = null;
          saveState();
        }
      }
    }
  }catch(e){ /* ignore corrupt data */ }
}
loadState();

/* ---------------------------------------------------------------------
   USAGE TRACKING
   Fire-and-forget POSTs to /api/track for the "App Usage Summary" tab and for
   app-functionality-testing monitoring. This ONLY works when the app is served by
   server.py (see project root) — the plain `python3 -m http.server` has no /api/track
   endpoint, so these calls just fail silently there and the app behaves identically
   either way; nothing about tracking is ever allowed to break or slow down a real action.
--------------------------------------------------------------------- */
// One id per page load (sessionStorage, not localStorage) — a reasonable stand-in for
// "one visit"; reloading the tab counts as a new visit, matching how the summary tab
// reports "visitor count" as unique sessions rather than unique people.
const TRACK_SESSION_ID = (function(){
  try{
    let id = sessionStorage.getItem("rms_session_id");
    if(!id){ id = genId("sess"); sessionStorage.setItem("rms_session_id", id); }
    return id;
  }catch(e){ return genId("sess"); } // sessionStorage unavailable (private mode, etc.)
})();
// The round-trip latency of the PREVIOUS tracking call — a request can't know its own
// latency until its response arrives, so each event reports the latency measured for the
// one before it. The very first event of a session has no prior sample (sent as "").
let lastTrackLatencyMs = null;
function trackEvent(functionName, opts){
  opts = opts || {};
  const body = {
    session_id: TRACK_SESSION_ID,
    event_type: opts.eventType || "action",
    function_name: functionName,
    generations: opts.generations!=null ? opts.generations : "",
    population_size: opts.populationSize!=null ? opts.populationSize : "",
    num_rooms: opts.numRooms!=null ? opts.numRooms : "",
    latency_ms: lastTrackLatencyMs==null ? "" : Math.round(lastTrackLatencyMs*10)/10,
    error_message: opts.errorMessage ? String(opts.errorMessage).slice(0,1000) : "",
    details: opts.extra || null
  };
  const now = (window.performance && performance.now) ? ()=>performance.now() : ()=>Date.now();
  const t0 = now();
  fetch("/api/track", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body),
    keepalive: true // let the request finish even if this fires right as the user navigates away
  }).then(()=>{ lastTrackLatencyMs = now() - t0; })
    .catch(()=>{ /* no tracking server running — never surfaced to the user */ });
}
// Never let a bug in the app go unrecorded, and never let recording it throw either.
window.addEventListener("error", (e)=>{
  trackEvent(e.filename ? e.filename.split("/").pop() : "window", { eventType:"error", errorMessage: e.message || String(e.error) });
});
window.addEventListener("unhandledrejection", (e)=>{
  trackEvent("promise", { eventType:"error", errorMessage: e.reason && e.reason.message ? e.reason.message : String(e.reason) });
});

/* ---------------------------------------------------------------------
   ROOMS
--------------------------------------------------------------------- */
// Fills an "open from" / "open until" select pair with every valid half-hour boundary
// across the outer 6:00 AM–11:00 PM window, defaulting to the app's standard hours.
function populateRoomHoursSelects(fromSel, untilSel, defaultFrom, defaultUntil){
  const from = defaultFrom==null ? DEFAULT_OPEN_MIN : defaultFrom;
  const until = defaultUntil==null ? DEFAULT_CLOSE_MIN : defaultUntil;
  fromSel.innerHTML = SLOT_TIMES.map(t=>
    `<option value="${t}" ${t===from?"selected":""}>${fmtTime(t)}</option>`
  ).join("");
  const untilTimes = SLOT_TIMES.slice(1).concat([END_MIN]);
  untilSel.innerHTML = untilTimes.map(t=>
    `<option value="${t}" ${t===until?"selected":""}>${fmtTime(t)}</option>`
  ).join("");
}

function addRoom(name, capacity, openMin, closeMin, usageLimitPercent, roomType){
  state.rooms.push({
    id: genId("room"),
    name: name,
    capacity: capacity || null,
    availability: makeAvailability(openMin, closeMin),
    // Shared-room cap: the optimizer will never book more than this % of the room's total
    // weekly open slots, leaving the rest free for whoever else the room is shared with.
    // Defaults to 100 (fully ours) for both new rooms and any imported/legacy data.
    usageLimitPercent: (usageLimitPercent==null || usageLimitPercent==="") ? 100 : usageLimitPercent,
    // "BOTH" (default, incl. any room from before this field existed) can host either type;
    // "LEC" / "LAB" is a hard constraint — the optimizer never offers it to the other type.
    roomType: (roomType==="LEC"||roomType==="LAB") ? roomType : "BOTH"
  });
  saveState();
  renderRooms();
  trackEvent("addRoom", { numRooms: state.rooms.length });
}
function deleteRoom(id){
  if(!confirm("Delete this room? This cannot be undone.")) return;
  state.rooms = state.rooms.filter(r=>r.id!==id);
  saveState();
  renderRooms();
  trackEvent("deleteRoom", { numRooms: state.rooms.length });
}
function availableSlotCount(room){
  let c=0;
  DAYS.forEach(d=> room.availability[d].forEach(v=>{ if(v) c++; }));
  return c;
}
// The most half-hour slots this app's optimizer is allowed to book into a (possibly shared)
// room this week — its total open slots, capped down to usageLimitPercent% of them.
function maxAllowedSlots(room){
  const pct = (room.usageLimitPercent==null) ? 100 : room.usageLimitPercent;
  return Math.floor(availableSlotCount(room) * clamp(pct, 0, 100) / 100);
}
// Total half-hour slots already booked into a room so far in this trial — shared by the GA
// decoder (to bias placement toward rooms already in use) and by candidate-finding (to
// enforce maxAllowedSlots for shared rooms).
function computeRoomLoad(occ, roomId){
  let load = 0;
  DAYS.forEach(d=> occ[roomId][d].forEach(v=>{ if(v) load++; }));
  return load;
}

function renderRooms(){
  document.getElementById("badge-rooms").textContent = state.rooms.length;
  const list = document.getElementById("room-list");
  if(state.rooms.length===0){
    list.innerHTML = '<div class="empty">No rooms yet. Add one above.</div>';
    return;
  }
  const roomTypeLabels = { BOTH:"LEC/LAB", LEC:"LEC Only", LAB:"LAB Only" };
  list.innerHTML = state.rooms.map(r=>{
    const total = DAYS.length*NUM_SLOTS;
    const avail = availableSlotCount(r);
    const usagePct = r.usageLimitPercent==null ? 100 : r.usageLimitPercent;
    const sharedTag = usagePct<100 ? ` &nbsp;•&nbsp; <span class="tag-external" title="This app's optimizer will only book up to ${usagePct}% of this room's open slots — the rest stays free for other shared use.">🔀 Shared: ${usagePct}% (max ${maxAllowedSlots(r)} slots)</span>` : "";
    const roomType = r.roomType==="LEC"||r.roomType==="LAB" ? r.roomType : "BOTH";
    const typeTag = roomType!=="BOTH" ? ` &nbsp;•&nbsp; <span class="tag-${roomType.toLowerCase()}">${roomTypeLabels[roomType]}</span>` : "";
    return `<div class="card" data-id="${r.id}">
      <div class="icon">🏫</div>
      <div class="info">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">${r.capacity ? "Capacity: "+r.capacity+" &nbsp;•&nbsp; " : ""}Open ${avail}/${total} half-hour slots this week${typeTag}${sharedTag}</div>
      </div>
      <div class="actions">
        <button class="btn btn-sm btn-ghost" data-action="edit-avail" data-id="${r.id}">Edit Availability</button>
        <button class="btn btn-sm btn-danger" data-action="delete-room" data-id="${r.id}">Delete</button>
      </div>
    </div>`;
  }).join("");
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------------------------------------------------------------------
   SUBJECTS
--------------------------------------------------------------------- */
function populateDurationSelect(){
  const sel = document.getElementById("subj-duration");
  sel.innerHTML = "";
  for(let slots=1; slots<=8; slots++){
    const mins = slots*SLOT_LEN;
    const h = Math.floor(mins/60), m = mins%60;
    let label = "";
    if(h>0) label += h+"h";
    if(m>0) label += (h>0?" ":"")+m+"m";
    const opt = document.createElement("option");
    opt.value = slots;
    opt.textContent = label;
    if(slots===2) opt.selected = true; // default 1h
    sel.appendChild(opt);
  }
}

// Builds a subject record without touching state/saving/rendering — used both by the
// single-subject Add form and by the bulk auto-populate-from-prospectus flow (which pushes
// many records in one pass, then saves/renders once at the end).
function buildSubjectRecord(name, durationSlots, sessionsPerWeek, size, isSplitPair, dayPairPref, type, isCapacitySplit, prospectusCourseId, externalAssignment, level){
  const idx = state.subjects.length;
  return {
    id: genId("subj"),
    name: name,
    durationSlots: durationSlots,
    sessionsPerWeek: sessionsPerWeek,
    size: size || null,
    color: COLORS[idx % COLORS.length],
    isSplitPair: !!isSplitPair,
    dayPairPref: isSplitPair ? (dayPairPref || "AUTO") : null,
    type: type === "LAB" ? "LAB" : "LEC",
    isCapacitySplit: !!isCapacitySplit,
    prospectusCourseId: prospectusCourseId || null,
    // External Assignment: room & faculty are handled by another college/department
    // (e.g. NSTP, PE) — the optimizer places only the class hours (TBA room, TBD faculty)
    // and skips room/faculty conflict-checking for this subject entirely.
    externalAssignment: !!externalAssignment,
    // Program Level: which flat per-subject teaching-load-unit value it counts as toward a
    // faculty member's load (see taskTeachingUnits) — "UG" (6 units) or "GRAD" (4.5 units).
    level: level==="GRAD" ? "GRAD" : "UG"
  };
}
function addSubject(name, durationSlots, sessionsPerWeek, size, isSplitPair, dayPairPref, type, isCapacitySplit, prospectusCourseId, externalAssignment, level){
  state.subjects.push(buildSubjectRecord(name, durationSlots, sessionsPerWeek, size, isSplitPair, dayPairPref, type, isCapacitySplit, prospectusCourseId, externalAssignment, level));
  saveState();
  renderSubjects();
  trackEvent("addSubject", { extra:{ type, externalAssignment: !!externalAssignment, level: level==="GRAD"?"GRAD":"UG" } });
}
function toggleSubjectExternal(id){
  const s = state.subjects.find(x=>x.id===id);
  if(!s) return;
  s.externalAssignment = !s.externalAssignment;
  saveState();
  renderSubjects();
  trackEvent("toggleSubjectExternal", { extra:{ externalAssignment: s.externalAssignment } });
}
function deleteSubject(id){
  if(!confirm("Delete this subject? This cannot be undone.")) return;
  state.subjects = state.subjects.filter(s=>s.id!==id);
  // Clean up any faculty references to the removed subject.
  state.faculty.forEach(f=>{ f.subjectIds = f.subjectIds.filter(sid=>sid!==id); });
  saveState();
  renderSubjects();
  renderFaculty();
  trackEvent("deleteSubject");
}

// Flat per-subject teaching-load-unit value a faculty member is credited once they're listed
// as handling this subject — used both for the Faculty tab's load summary and as a soft
// preference in the optimizer (see runTrial's faculty load tracking). A Laboratory subject
// whose session runs 3 hours or longer is always 2.55 units regardless of level; anything
// else is a flat 6 units for an Undergraduate subject or 4.5 for a Graduate one.
function subjectTeachingUnits(subject){
  const durationMin = (subject.durationSlots||0) * SLOT_LEN;
  if(subject.type==="LAB" && durationMin>=180) return 2.55;
  return subject.level==="GRAD" ? 4.5 : 6;
}
// Same computation from a GA task object (buildTasks copies durationSlots/subjectType/level
// onto every task so runTrial never needs to look the subject record back up mid-decode).
function taskTeachingUnits(task){
  const durationMin = (task.durationSlots||0) * SLOT_LEN;
  if(task.subjectType==="LAB" && durationMin>=180) return 2.55;
  return task.level==="GRAD" ? 4.5 : 6;
}

function renderSubjects(){
  document.getElementById("badge-subjects").textContent = state.subjects.length;
  const list = document.getElementById("subject-list");
  if(state.subjects.length===0){
    list.innerHTML = '<div class="empty">No subjects yet. Add one above.</div>';
    return;
  }
  const prospectusById = {};
  state.prospectus.forEach(c=> prospectusById[c.id] = c);
  list.innerHTML = state.subjects.map(s=>{
    const mins = s.durationSlots*SLOT_LEN;
    const h = Math.floor(mins/60), m = mins%60;
    const durLabel = (h>0?h+"h ":"")+(m>0?m+"m":"");
    const type = s.type === "LAB" ? "LAB" : "LEC";
    const typeTag = `<span class="tag-${type.toLowerCase()}">${type}</span>`;
    const scheduleMeta = s.isSplitPair
      ? `${durLabel} × 2 &nbsp;•&nbsp; paired (${DAY_PAIR_LABELS[s.dayPairPref]}, same time)`
      : s.isCapacitySplit
        ? `${durLabel} × 2 identical sections &nbsp;•&nbsp; room-capacity split`
        : `${durLabel} per session &nbsp;•&nbsp; ${s.sessionsPerWeek}x/week`;
    const prospectusCourse = s.prospectusCourseId ? prospectusById[s.prospectusCourseId] : null;
    const prospectusTag = prospectusCourse
      ? ` &nbsp;•&nbsp; <span class="tag-lab">🎓 ${escapeHtml(prospectusCourse.code)}</span>`
      : "";
    const externalTag = s.externalAssignment
      ? ` &nbsp;•&nbsp; <span class="tag-external">🏢 External (TBA/TBD)</span>`
      : "";
    const levelTag = s.level==="GRAD" ? ` &nbsp;•&nbsp; <span class="tag-lab">GRAD</span>` : "";
    const unitsTag = ` &nbsp;•&nbsp; <span style="color:var(--text-dim);font-size:12px;" title="Teaching-load units this subject counts toward a faculty member's total when they're listed as handling it">${subjectTeachingUnits(s)}u load</span>`;
    return `<div class="card" data-id="${s.id}">
      <div class="swatch" style="background:${s.color}"></div>
      <div class="info">
        <div class="name">${escapeHtml(s.name)} ${typeTag}</div>
        <div class="meta">${scheduleMeta}${s.size ? " &nbsp;•&nbsp; ~"+s.size+" students" : ""}${prospectusTag}${externalTag}${levelTag}${unitsTag}</div>
      </div>
      <div class="actions">
        <button class="btn btn-sm btn-ghost" data-action="toggle-external" data-id="${s.id}">${s.externalAssignment ? "Unmark External" : "Mark External"}</button>
        <button class="btn btn-sm btn-danger" data-action="delete-subject" data-id="${s.id}">Delete</button>
      </div>
    </div>`;
  }).join("");
  populateFacultySubjectSelect();
}

/* ---------------------------------------------------------------------
   FACULTY
--------------------------------------------------------------------- */
// The course CODE to show for a subject wherever Faculty needs it: the linked prospectus
// course's actual CourseCode when there is one (auto-populated subjects are named after the
// course TITLE, e.g. "Chemistry for Engineers Laboratory", not its code), otherwise the
// subject's own name (which IS the code for manually-added subjects — see the Subjects tab).
function subjectCodeLabel(s){
  if(s.prospectusCourseId){
    const course = state.prospectus.find(c=>c.id===s.prospectusCourseId);
    if(course && course.code) return course.code;
  }
  return s.name;
}
function populateFacultySubjectSelect(){
  const sel = document.getElementById("faculty-subjects");
  if(!sel) return;
  const prevSelected = new Set(Array.from(sel.selectedOptions).map(o=>o.value));
  // External-Assignment subjects have no faculty of ours to assign (faculty is TBD, handled
  // by another college), so they're left out of this list entirely. Shown by course code only.
  sel.innerHTML = state.subjects.filter(s=>!s.externalAssignment).map(s=>{
    return `<option value="${s.id}" ${prevSelected.has(s.id)?"selected":""}>${escapeHtml(subjectCodeLabel(s))}</option>`;
  }).join("");
}

// Case/whitespace-insensitive name match — same identity rule used for prospectus-course
// duplicate detection elsewhere in the app.
function findFacultyByName(name){
  const key = String(name||"").trim().toLowerCase();
  return state.faculty.find(f=> f.name.trim().toLowerCase()===key);
}
// Adding a faculty member whose name already exists doesn't create a second entry — the
// newly-picked subjects are merged (deduplicated) into the existing faculty's handled-subject
// list instead, so re-adding the same name is how you extend what they teach. Admin/Research
// Load Units is simply overwritten with whatever's submitted (defaulting to 0) — re-adding a
// name is also how you update that value.
function addFaculty(name, subjectIds, adminResearchUnits){
  const units = (typeof adminResearchUnits==="number" && adminResearchUnits>=0) ? adminResearchUnits : 0;
  const existing = findFacultyByName(name);
  if(existing){
    const merged = new Set(existing.subjectIds);
    (subjectIds||[]).forEach(id=> merged.add(id));
    existing.subjectIds = Array.from(merged);
    existing.adminResearchUnits = units;
    saveState();
    renderFaculty();
    trackEvent("addFaculty", { extra:{ subjectCount: (subjectIds||[]).length, merged:true, adminResearchUnits: units } });
    return;
  }
  state.faculty.push({
    id: genId("fac"),
    name: name,
    subjectIds: subjectIds || [],
    // Admin/Research Load Units: the non-teaching portion of a faculty member's total load.
    // Policy (enforced/advised in the Faculty tab and the optimizer, never a hard block):
    // total load should be at least 18 units, max PAYABLE 24 (going over is allowed but "not
    // advisable"); if admin/research alone already exceeds 18, at least one teaching subject
    // is required on top of it.
    adminResearchUnits: units
  });
  saveState();
  renderFaculty();
  trackEvent("addFaculty", { extra:{ subjectCount: (subjectIds||[]).length, merged:false, adminResearchUnits: units } });
}
// Computes a faculty member's current load picture from their handled-subject list — teaching
// units (subjectTeachingUnits summed once per subject), admin/research (their own stored
// value), the total, and a status describing where that total sits against policy.
function facultyLoadSummary(faculty){
  const subjectById = {};
  state.subjects.forEach(s=> subjectById[s.id]=s);
  let teachingUnits = 0;
  faculty.subjectIds.forEach(sid=>{
    const s = subjectById[sid];
    if(s) teachingUnits += subjectTeachingUnits(s);
  });
  teachingUnits = Math.round(teachingUnits*100)/100;
  const adminResearchUnits = faculty.adminResearchUnits || 0;
  const total = Math.round((teachingUnits + adminResearchUnits)*100)/100;
  const needsTeachingLoad = adminResearchUnits > 18 && teachingUnits <= 0;
  let status, statusClass;
  if(needsTeachingLoad){
    status = "Needs at least 1 teaching-load subject (admin/research is over 18 units)";
    statusClass = "tag-none";
  } else if(total < 18){
    status = "Underloaded — below the 18-unit minimum";
    statusClass = "tag-external";
  } else if(total > 24){
    status = "Over the 24-unit payable maximum — allowed, but not advisable";
    statusClass = "tag-external";
  } else {
    status = "Within policy (18–24 units)";
    statusClass = "tag-lec";
  }
  return { teachingUnits, adminResearchUnits, total, status, statusClass, needsTeachingLoad };
}
function deleteFaculty(id){
  if(!confirm("Delete this faculty member? This cannot be undone.")) return;
  state.faculty = state.faculty.filter(f=>f.id!==id);
  saveState();
  renderFaculty();
  trackEvent("deleteFaculty");
}

// Faculty roster is a single-select listbox (highlight one faculty member at a time) — the
// highlighted one's handled-subject codes are shown in the detail panel next to it, and
// "Delete Selected" acts on whichever row is highlighted.
function renderFaculty(){
  const badge = document.getElementById("badge-faculty");
  if(badge) badge.textContent = state.faculty.length;
  const sel = document.getElementById("faculty-list-select");
  if(!sel) return;
  const prevSelectedId = sel.value;
  if(state.faculty.length===0){
    sel.innerHTML = '<option value="" disabled>No faculty yet. Add one above.</option>';
  } else {
    sel.innerHTML = state.faculty.map(f=> `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("");
    if(state.faculty.some(f=>f.id===prevSelectedId)) sel.value = prevSelectedId;
  }
  renderFacultyDetail();
}
function renderFacultyDetail(){
  const sel = document.getElementById("faculty-list-select");
  const detail = document.getElementById("faculty-detail-subjects");
  const delBtn = document.getElementById("delete-faculty-btn");
  const loadEl = document.getElementById("faculty-detail-load");
  if(!sel || !detail || !delBtn) return;
  const f = state.faculty.find(x=>x.id===sel.value);
  if(!f){
    detail.innerHTML = `<span style="color:var(--text-dim);font-size:12px;">Highlight a faculty member to see their subjects.</span>`;
    if(loadEl) loadEl.innerHTML = "";
    delBtn.disabled = true;
    return;
  }
  delBtn.disabled = false;
  const subjectById = {};
  state.subjects.forEach(s=> subjectById[s.id]=s);
  detail.innerHTML = f.subjectIds.length
    ? f.subjectIds.map(sid=>{
        const s = subjectById[sid];
        return s ? `<span class="faculty-subject-chip">${escapeHtml(subjectCodeLabel(s))}</span>` : "";
      }).join("")
    : `<span style="color:var(--text-dim);font-size:12px;">No subjects listed yet — won't be conflict-checked</span>`;
  if(loadEl){
    const load = facultyLoadSummary(f);
    loadEl.innerHTML = `
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;">
        <div><span style="color:var(--text-dim);font-size:11px;text-transform:uppercase;">Teaching</span><br><b>${load.teachingUnits}u</b></div>
        <div><span style="color:var(--text-dim);font-size:11px;text-transform:uppercase;">Admin/Research</span><br><b>${load.adminResearchUnits}u</b></div>
        <div><span style="color:var(--text-dim);font-size:11px;text-transform:uppercase;">Total</span><br><b>${load.total}u</b></div>
      </div>
      <span class="${load.statusClass}">${escapeHtml(load.status)}</span>`;
  }
}

/* ---------------------------------------------------------------------
   PROSPECTUS (program curriculum, used for regular-student conflict-checking)
--------------------------------------------------------------------- */
const YEAR_LABEL_TO_NUM = { "First Year":1, "Second Year":2, "Third Year":3, "Fourth Year":4, "Fifth Year":5 };

function prospectusTermKey(course){ return course.yearLabel + "|" + course.term; }
// Groups a course by Program + Year + Term — the full display/grouping identity used
// throughout the Prospectus tab now that multiple degree programs can coexist.
function prospectusGroupKey(course){ return (course.program||"General") + "|" + course.yearLabel + "|" + course.term; }
// Duplicate-course identity: same Program + Year + Term + Code. Deliberately includes
// Program (not just Code) — course codes like "NSTP01" or "PE1" are legitimately reused
// across many different degree programs, and those are NOT duplicates of each other.
function prospectusDupKey(program, yearLabel, term, code){
  return [program, yearLabel, term, code].map(x=> String(x||"").trim().toLowerCase()).join("|");
}
function distinctPrograms(){
  const seen = new Set(); const out = [];
  state.prospectus.forEach(c=>{ const p=c.program||"General"; if(!seen.has(p)){ seen.add(p); out.push(p); } });
  return out;
}

// subject.prospectusCourseId -> which regular-student cohort (Program + Year Level) must it
// stay conflict-free against? Returns a Map of subjectId -> "program|yearLabel". Two subjects
// only ever block each other if they share the SAME program AND SAME year level — different
// programs' students (or different year levels within the same program) are different people
// and are free to overlap. Scoped to courses in the currently-selected target TERM only (the
// Target Semester picker), so this naturally spans every uploaded program at once.
function buildCohortGroups(){
  const map = {};
  if(!state.targetTerm) return map;
  const courseIdToGroup = {};
  state.prospectus.forEach(c=>{
    if(normalizeTermValue(c.term) === state.targetTerm) courseIdToGroup[c.id] = (c.program||"General") + "|" + c.yearLabel;
  });
  state.subjects.forEach(s=>{
    if(s.prospectusCourseId && courseIdToGroup[s.prospectusCourseId]) map[s.id] = courseIdToGroup[s.prospectusCourseId];
  });
  return map;
}

// Auto-populates the Subjects tab with default subjects for every course across EVERY
// uploaded program in the selected term — triggered when the user picks a Target Semester,
// so multiple degree programs' full course load for that term is ready to optimize together
// with no manual re-entry. Idempotent: a course that already has a linked subject is skipped,
// so re-running (e.g. after adding more prospectus courses) never creates duplicates.
//
// Duration/session shape is derived from the prospectus's weekly Lec/Lab hours per the
// scheduling constraints (review/adjust afterward in the Subjects tab):
//   LEC — for 3+ units: weekly lecture hours ÷ 2 = each session's length, met twice a week
//         at the same time, on the Mon/Wed, Tue/Thu, or Fri/Sat counterpart days (constraint
//         #2). Under 3 units doesn't need that split: one weekly session at the full
//         duration, met once a week instead (constraint #5).
//   LAB — weekly lab hours (already units x3 by convention) stay one weekly block up to
//         3 hours; beyond that, split into fixed 3-hour sessions — hours ÷ 3 = sessions/week,
//         each placed on whatever day works best (constraint #3).
// NST001/NST002 (NSTP) are ALSO kept to a single weekly block regardless of units: the
// twice-a-week pairing can never land on Sunday, but NSTP conventionally meets there
// (constraint #1's Sunday exception).
function autoPopulateSubjectsForTerm(term){
  if(!term) return { added:0, skipped:0, matched:0 };
  const courses = state.prospectus.filter(c=> normalizeTermValue(c.term)===term);
  if(courses.length===0) return { added:0, skipped:0, matched:0 };
  const linkedCourseIds = new Set(state.subjects.map(s=>s.prospectusCourseId).filter(Boolean));
  let added = 0, skipped = 0;
  courses.forEach(c=>{
    if(linkedCourseIds.has(c.id)){ skipped++; return; }
    const lec = c.lec || 0, lab = c.lab || 0;
    if(lec<=0 && lab<=0){ skipped++; return; }
    const tag = c.program ? ` [${c.program}]` : "";
    const isSundayExempt = SUNDAY_EXEMPT_CODES.includes((c.code||"").trim().toUpperCase());
    if(lec>0){
      // lec hours/week is also the lecture unit count by convention (1 unit = 1 hr/week) —
      // under 3 units skips the twice-a-week split, same as the Sunday-exempt case.
      if(isSundayExempt || lec < 3){
        const slots = clamp(Math.round(lec*2), 1, 16); // one weekly block sized to full lec hours
        state.subjects.push(buildSubjectRecord(
          c.title + tag, slots, 1, null,
          false, null, "LEC", false, c.id, false
        ));
      } else {
        const perSessionSlots = clamp(Math.round(lec), 1, 16); // (lec hrs / 2) x 2 slots/hr = lec
        state.subjects.push(buildSubjectRecord(
          c.title + tag, perSessionSlots, 2, null,
          true, "AUTO", "LEC", false, c.id, false
        ));
      }
      added++;
    }
    if(lab>0){
      const totalLabSlots = clamp(Math.round(lab*2), 1, 999); // weekly lab hours -> 30min slots
      let labDurationSlots, labSessions;
      if(totalLabSlots <= 6){ // <=3 hours: one weekly block
        labDurationSlots = totalLabSlots;
        labSessions = 1;
      } else { // >3 hours: fixed 3-hour sessions, hours/week / 3 = sessions/week
        labDurationSlots = 6;
        labSessions = clamp(Math.round(totalLabSlots/6), 1, 7);
      }
      state.subjects.push(buildSubjectRecord(
        c.title + (lec>0 ? " (Lab)" : "") + tag, labDurationSlots, labSessions, null,
        false, null, "LAB", false, c.id, false
      ));
      added++;
    }
  });
  return { added, skipped, matched: courses.length };
}

// Wipes EVERY subject in the Subject tab — used when switching the Target Semester, so a
// newly-selected term always starts from a clean slate instead of mixing in whatever was
// listed before (auto-loaded from a previous term, or added by hand). Cleans up faculty's
// subjectIds references (same as deleteSubject, just for everything at once) and clears a
// stale schedule result, since it would otherwise reference subject IDs that no longer exist.
function clearAllSubjects(){
  const removedCount = state.subjects.length;
  if(removedCount===0) return 0;
  state.subjects = [];
  state.faculty.forEach(f=>{ f.subjectIds = []; });
  if(state.schedule) state.schedule = null;
  return removedCount;
}

function populateSubjectProspectusSelect(){
  const sel = document.getElementById("subj-prospectus-course");
  if(!sel) return;
  const prev = sel.value;
  const groups = {};
  const order = [];
  state.prospectus.forEach(c=>{
    const key = prospectusGroupKey(c);
    if(!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(c);
  });
  let html = '<option value="">— none —</option>';
  order.forEach(key=>{
    const [program, yearLabel, term] = key.split("|");
    html += `<optgroup label="${escapeHtml(program)} — ${escapeHtml(yearLabel)} — ${escapeHtml(term)}">`;
    groups[key].forEach(c=>{
      html += `<option value="${c.id}">${escapeHtml(c.code)}: ${escapeHtml(c.title)}</option>`;
    });
    html += `</optgroup>`;
  });
  sel.innerHTML = html;
  if(state.prospectus.some(c=>c.id===prev)) sel.value = prev;
}

// Always exactly the 3 real-world terms — not derived from what's been uploaded — so
// selecting one is a simple, predictable "which term am I scheduling" choice regardless of
// how many programs/years happen to be in the prospectus yet.
function populateTargetTermSelect(){
  const sel = document.getElementById("target-term-select");
  if(!sel) return;
  let html = '<option value="">— none (no curriculum-conflict check) —</option>';
  PROSPECTUS_TERMS.forEach(t=> html += `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
  sel.innerHTML = html;
  sel.value = PROSPECTUS_TERMS.includes(state.targetTerm) ? state.targetTerm : "";
  if(!PROSPECTUS_TERMS.includes(state.targetTerm) && state.targetTerm){ state.targetTerm = ""; saveState(); }
  updateTargetTermHint();
}

function renderProspectus(){
  const badge = document.getElementById("badge-prospectus");
  // Counts uploaded PROGRAMS, not individual courses — a badge of "74" (course count) reads
  // as broken/alarming, while "1" (one uploaded prospectus) matches what the tab is about.
  if(badge) badge.textContent = distinctPrograms().length;
  const container = document.getElementById("prospectus-list");
  if(!container) return;
  if(state.prospectus.length===0){
    container.innerHTML = '<div class="empty">No prospectus uploaded yet. Import a CSV or upload a PDF above.</div>';
  } else {
    // Program first, then Year+Term within each program — multiple degree programs stay
    // visually separated even though they're all optimized together.
    const programGroups = {};
    const programOrder = [];
    state.prospectus.forEach(c=>{
      const p = c.program || "General";
      if(!programGroups[p]){ programGroups[p] = []; programOrder.push(p); }
      programGroups[p].push(c);
    });
    container.innerHTML = programOrder.map(program=>{
      const courses = programGroups[program];
      const termGroups = {};
      const termOrder = [];
      courses.forEach(c=>{
        const key = prospectusTermKey(c);
        if(!termGroups[key]){ termGroups[key] = []; termOrder.push(key); }
        termGroups[key].push(c);
      });
      const termsHtml = termOrder.map(key=>{
        const termCourses = termGroups[key];
        const [yearLabel, term] = key.split("|");
        return `<div class="prospectus-group">
          <div class="prospectus-group-title">${escapeHtml(yearLabel)} — ${escapeHtml(term)} <span class="tag-lec" style="margin-left:8px;">${termCourses.length} course${termCourses.length===1?"":"s"}</span></div>
          <table class="list-table">
            <thead><tr><th>Code</th><th>Title</th><th>Units</th><th>Lec</th><th>Lab</th><th></th></tr></thead>
            <tbody>${termCourses.map(c=>`
              <tr>
                <td>${escapeHtml(c.code)}</td>
                <td>${escapeHtml(c.title)}</td>
                <td>${c.units==null?"":c.units}</td>
                <td>${c.lec||0}</td>
                <td>${c.lab||0}</td>
                <td><button class="btn btn-sm btn-danger" data-action="delete-prospectus-course" data-id="${c.id}">Delete</button></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
      }).join("");
      return `<div class="prospectus-program-group">
        <div class="prospectus-program-title">🎓 ${escapeHtml(program)} <span class="tag-external" style="margin-left:8px;">${courses.length} course${courses.length===1?"":"s"}</span>
          <button class="btn btn-sm btn-danger" data-action="delete-prospectus-program" data-program="${escapeHtml(program)}" style="margin-left:10px;">Delete Program</button>
        </div>
        ${termsHtml}
      </div>`;
    }).join("");
  }
  populateSubjectProspectusSelect();
  populateTargetTermSelect();
  updateProspectusProgramList();
}

// Autocomplete list for the "Program Name" input, drawn from programs already uploaded, so
// re-uploading more courses into an existing program is a consistent, typo-free pick.
function updateProspectusProgramList(){
  const list = document.getElementById("prospectus-program-list");
  if(!list) return;
  list.innerHTML = distinctPrograms().map(p=>`<option value="${escapeHtml(p)}"></option>`).join("");
}

function deleteProspectusCourse(id){
  if(!confirm("Delete this prospectus course? Any subject linked to it will be unlinked.")) return;
  state.prospectus = state.prospectus.filter(c=>c.id!==id);
  state.subjects.forEach(s=>{ if(s.prospectusCourseId===id) s.prospectusCourseId = null; });
  saveState();
  renderProspectus();
  renderSubjects();
  trackEvent("deleteProspectusCourse");
}
function deleteProspectusProgram(program){
  if(!confirm(`Delete every course uploaded under "${program}"? Any subject linked to one will be unlinked. This cannot be undone.`)) return;
  const removedIds = new Set(state.prospectus.filter(c=>(c.program||"General")===program).map(c=>c.id));
  state.prospectus = state.prospectus.filter(c=> !removedIds.has(c.id));
  state.subjects.forEach(s=>{ if(s.prospectusCourseId && removedIds.has(s.prospectusCourseId)) s.prospectusCourseId = null; });
  saveState();
  renderProspectus();
  renderSubjects();
  trackEvent("deleteProspectusProgram");
}
function clearProspectus(){
  if(state.prospectus.length===0) return;
  if(!confirm("Clear the entire uploaded prospectus (all programs)? Linked subjects will be unlinked. This cannot be undone.")) return;
  state.prospectus = [];
  state.subjects.forEach(s=>{ s.prospectusCourseId = null; });
  state.targetTerm = "";
  saveState();
  renderProspectus();
  renderSubjects();
  trackEvent("clearProspectus");
}

/* --- CSV import/export (reuses the generic CSV helpers defined later in this file — see
   IMPORT / EXPORT section — via the shared parseCsv/rowsToCsv/downloadCsv/handleCsvImport) --- */
function exportProspectusCsv(){
  if(state.prospectus.length===0){ alert("No prospectus courses to export yet."); return; }
  const rows = [["Program","Year","Term","CourseCode","CourseTitle","Units","LecHoursPerWeek","LabHoursPerWeek"]];
  state.prospectus.forEach(c=> rows.push([c.program||"General", c.yearLabel, c.term, c.code, c.title, c.units==null?"":c.units, c.lec||0, c.lab||0]));
  downloadCsv("prospectus.csv", rows);
}
function downloadProspectusTemplate(){
  downloadCsv("prospectus-template.csv", [
    ["Program","Year","Term","CourseCode","CourseTitle","Units","LecHoursPerWeek","LabHoursPerWeek"],
    ["BS Electrical Engineering","First Year","First Semester","MAT060","Calculus with Analytical Geometry 1","4","4","0"],
    ["BS Electrical Engineering","First Year","First Semester","CHM012.1","Chemistry for Engineers Laboratory","1","0","3"],
    ["BS Electrical Engineering","Third Year","Summer Term","EEE197","On-the-Job Training","3","0","240"],
    ["BS Civil Engineering","First Year","First Semester","MAT060","Calculus with Analytical Geometry 1","4","4","0"]
  ]);
}
// `defaultProgram` is used for any row that leaves its own Program column blank (a CSV can
// mix explicit per-row programs and blank ones that fall back to the Prospectus tab's
// "Program Name" field). Duplicate rows (same Program+Year+Term+Code as something already in
// the prospectus, or repeated within this same import) are skipped and counted separately.
function importProspectusFromRows(dataRows, defaultProgram){
  let added = 0, skipped = 0, duplicates = 0;
  const seen = new Set(state.prospectus.map(c=> prospectusDupKey(c.program, c.yearLabel, c.term, c.code)));
  dataRows.forEach(cols=>{
    // Auto-detect an old-format row (pre-multi-program: Year,Term,Code,Title,Units,Lec,Lab —
    // no leading Program column) by checking whether column 0 is a recognizable Year Label
    // rather than a program name. Without this, re-importing an existing/older prospectus CSV
    // (very likely once someone already has "1 uploaded" from before Program existed) would
    // silently shift every field one column over — corrupting Term into a course code and
    // making every course invisible to Target Semester selection with no visible error.
    const isOldFormat = YEAR_LABEL_TO_NUM.hasOwnProperty((cols[0]||"").trim());
    const off = isOldFormat ? -1 : 0; // old format has no leading Program column
    const program = isOldFormat ? (defaultProgram||"").trim() : ((cols[0]||"").trim() || (defaultProgram||"").trim());
    const yearLabel = (cols[1+off]||"").trim();
    const term = normalizeTermValue(cols[2+off]);
    const code = (cols[3+off]||"").trim();
    const title = (cols[4+off]||"").trim();
    if(!program || !yearLabel || !term || !code || !title){ skipped++; return; }
    const key = prospectusDupKey(program, yearLabel, term, code);
    if(seen.has(key)){ duplicates++; return; }
    seen.add(key);
    const unitsRaw = parseFloat(cols[5+off]);
    const lecRaw = parseInt(cols[6+off],10);
    const labRaw = parseInt(cols[7+off],10);
    state.prospectus.push({
      id: genId("psc"),
      program,
      year: YEAR_LABEL_TO_NUM[yearLabel] || null,
      yearLabel, term, code, title,
      units: isNaN(unitsRaw) ? null : unitsRaw,
      lec: isNaN(lecRaw) ? 0 : lecRaw,
      lab: isNaN(labRaw) ? 0 : labRaw
    });
    added++;
  });
  saveState();
  renderProspectus();
  trackEvent("importProspectusCsv", { extra:{ added, skipped, duplicates } });
  return { added, skipped, duplicates };
}

/* --- PDF upload + review-before-import (parsing itself lives in prospectus-pdf.js) --- */
let prospectusReviewRows = [];
function openProspectusReviewModal(parsedRows, program){
  prospectusReviewRows = parsedRows.map(c=>({ program, ...c }));
  renderProspectusReviewTable();
  document.getElementById("prospectus-review-modal-backdrop").classList.add("open");
}
function closeProspectusReviewModal(){
  document.getElementById("prospectus-review-modal-backdrop").classList.remove("open");
}
function renderProspectusReviewTable(){
  const table = document.getElementById("prospectus-review-table");
  const existingKeys = new Set(state.prospectus.map(c=> prospectusDupKey(c.program, c.yearLabel, c.term, c.code)));
  table.innerHTML = `<thead><tr><th>Program</th><th>Year</th><th>Term</th><th>Code</th><th>Title</th><th>Units</th><th>Lec</th><th>Lab</th><th></th></tr></thead>
    <tbody>${prospectusReviewRows.map((c,i)=>{
      const isDup = existingKeys.has(prospectusDupKey(c.program, c.yearLabel, c.term, c.code));
      return `
      <tr${isDup ? ' style="opacity:.55;"' : ''}>
        <td><input data-i="${i}" data-f="program" value="${escapeHtml(c.program||"")}" style="width:130px;"></td>
        <td><input data-i="${i}" data-f="yearLabel" value="${escapeHtml(c.yearLabel||"")}"></td>
        <td><input data-i="${i}" data-f="term" value="${escapeHtml(c.term||"")}"></td>
        <td><input data-i="${i}" data-f="code" value="${escapeHtml(c.code||"")}" style="width:90px;"></td>
        <td><input data-i="${i}" data-f="title" value="${escapeHtml(c.title||"")}" style="min-width:220px;"></td>
        <td><input data-i="${i}" data-f="units" type="number" value="${c.units==null?"":c.units}" style="width:60px;"></td>
        <td><input data-i="${i}" data-f="lec" type="number" value="${c.lec==null?0:c.lec}" style="width:55px;"></td>
        <td><input data-i="${i}" data-f="lab" type="number" value="${c.lab==null?0:c.lab}" style="width:55px;"></td>
        <td>${isDup ? '<span class="tag-external" title="Already in your prospectus — will be skipped as a duplicate">dup</span>' : ''}<button class="btn btn-sm btn-danger" data-remove="${i}">✕</button></td>
      </tr>`;
    }).join("")}
    </tbody>`;
}

/* ---------------------------------------------------------------------
   AVAILABILITY EDITOR MODAL
--------------------------------------------------------------------- */
let editingRoomId = null;

function openAvailModal(roomId){
  editingRoomId = roomId;
  const room = state.rooms.find(r=>r.id===roomId);
  if(!room) return;
  document.getElementById("avail-modal-title").textContent = "Edit Availability — " + room.name;
  renderAvailGrid(room);
  populateRoomHoursSelects(
    document.getElementById("avail-custom-from"),
    document.getElementById("avail-custom-until")
  );
  document.getElementById("avail-modal-backdrop").classList.add("open");
}
function closeAvailModal(){
  document.getElementById("avail-modal-backdrop").classList.remove("open");
  editingRoomId = null;
  renderRooms();
}

function renderAvailGrid(room){
  const table = document.getElementById("avail-grid-table");
  let html = "<tr><th></th>";
  for(let i=0;i<NUM_SLOTS;i++){
    html += `<th>${i%2===0 ? slotLabel(i).replace(" ","") : ""}</th>`;
  }
  html += "</tr>";
  DAYS.forEach(day=>{
    html += `<tr><td class="daylabel" data-day="${day}">${day}</td>`;
    for(let i=0;i<NUM_SLOTS;i++){
      const on = room.availability[day][i];
      html += `<td class="avail-cell ${on?"on":"off"}" data-day="${day}" data-idx="${i}" title="${DAY_FULL[day]} ${slotLabel(i)}"></td>`;
    }
    html += "</tr>";
  });
  table.innerHTML = html;
}

document.getElementById("avail-grid-table").addEventListener("click", (e)=>{
  const room = state.rooms.find(r=>r.id===editingRoomId);
  if(!room) return;
  const dayLabel = e.target.closest(".daylabel");
  if(dayLabel){
    const day = dayLabel.dataset.day;
    const arr = room.availability[day];
    const mostlyOn = arr.filter(Boolean).length >= arr.length/2;
    room.availability[day] = arr.map(()=> !mostlyOn);
    saveState();
    renderAvailGrid(room);
    return;
  }
  const cell = e.target.closest(".avail-cell");
  if(cell){
    const day = cell.dataset.day, idx = +cell.dataset.idx;
    room.availability[day][idx] = !room.availability[day][idx];
    saveState();
    renderAvailGrid(room);
  }
});

document.querySelectorAll("[data-preset]").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const room = state.rooms.find(r=>r.id===editingRoomId);
    if(!room) return;
    const preset = btn.dataset.preset;
    DAYS.forEach(day=>{
      let val;
      if(preset==="all") val = true;
      else if(preset==="none") val = false;
      else if(preset==="weekdays") val = ["Mon","Tue","Wed","Thu","Fri"].includes(day);
      else if(preset==="weekend") val = ["Sat","Sun"].includes(day);
      room.availability[day] = room.availability[day].map(()=>val);
    });
    saveState();
    renderAvailGrid(room);
  });
});

document.getElementById("avail-custom-apply").addEventListener("click", ()=>{
  const room = state.rooms.find(r=>r.id===editingRoomId);
  if(!room) return;
  const openMin = parseInt(document.getElementById("avail-custom-from").value, 10);
  const closeMin = parseInt(document.getElementById("avail-custom-until").value, 10);
  if(closeMin <= openMin){ alert('"Open Until" must be after "Open From".'); return; }
  // Overrides every day at once with the chosen custom hours, replacing whatever was
  // toggled before — a quick way to widen/narrow a room's hours instead of clicking
  // 34 x 7 cells by hand. Individual days/slots can still be fine-tuned afterward.
  room.availability = makeAvailability(openMin, closeMin);
  saveState();
  renderAvailGrid(room);
});

document.getElementById("avail-modal-done").addEventListener("click", closeAvailModal);
document.getElementById("avail-modal-backdrop").addEventListener("click", (e)=>{
  if(e.target.id === "avail-modal-backdrop") closeAvailModal();
});

/* ---------------------------------------------------------------------
   OPTIMIZER
   Randomized greedy with restarts. Each trial tries to place every
   Genetic Algorithm (permutation encoding): a chromosome is an ordering of
   the scheduling tasks. Each order is decoded, deterministically and
   conflict-free, by a greedy placer that walks the order and gives each
   task the best still-free (room, day, start-slot, faculty) it can find —
   respecting room availability & capacity, faculty qualification &
   non-overlap (checked globally across all rooms), one-session-per-day per
   subject, no Sunday sessions except NST001/NST002 (constraint #1), Room
   Type (LEC/LAB/Both) honored as a hard room constraint (constraint #1b),
   and a soft same-day/before-6PM preference for Laboratory subjects plus a
   soft Friday-avoidance preference for energy savings (constraint #4). The
   GA also softly steers each faculty member toward keeping a free
   10:30AM-12:00NN or 12:00NN-1:30PM break (constraint #3) and away from
   large idle gaps in their daily schedule (constraint #4b). The GA evolves
   populations of orderings via tournament selection, order crossover (OX)
   and swap mutation, scoring each decoded result by (1) sessions
   scheduled, (2) room-utilization (packing density, fewer half-empty
   room-days), (3) lab sessions kept within 7:30AM-6:00PM, (4) fewer Friday
   sessions, (5) faculty break windows honored, (6) tighter faculty
   daily schedules.
--------------------------------------------------------------------- */
const LAB_PREFERRED_END_MIN = 18*60; // 6:00 PM — soft cutoff for Laboratory subjects (constraint #2)

// Constraint #3: the optimizer tries to keep at least ONE of these two windows completely
// free of classes, for every faculty member, across the whole week (a guaranteed break) —
// soft/best-effort, same as the other "if possible" preferences here.
const FACULTY_BREAK_WINDOWS = [
  { start: 10*60+30, end: 12*60 },   // 10:30 AM – 12:00 NN
  { start: 12*60, end: 13*60+30 }    // 12:00 NN – 1:30 PM
].map(w=> Object.assign({}, w, { slots: SLOT_TIMES.map((t,i)=> (t>=w.start && t<w.end) ? i : -1).filter(i=>i>=0) }));

// Constraint #1: is this subject one of the Sunday exceptions (NST001/NST002 — NSTP)? Checks
// the linked prospectus course's code first, falling back to the subject's own name so a
// manually-added "NST001 ..." subject (no prospectus link) is still recognized.
function isSundayExemptSubject(s){
  const course = s.prospectusCourseId ? state.prospectus.find(c=>c.id===s.prospectusCourseId) : null;
  if(course && SUNDAY_EXEMPT_CODES.includes((course.code||"").trim().toUpperCase())) return true;
  const name = (s.name||"").toUpperCase();
  return SUNDAY_EXEMPT_CODES.some(code=> name.includes(code));
}
// Which days a task may be placed on: every day for a Sunday-exempt subject, otherwise every
// day except Sunday. Paired (MW/TTh/FSa) tasks never reach Sunday in the first place, so this
// only matters for "single"-task placement (regular multi-session and Lab subjects).
function candidateDaysFor(task){ return task.allowSunday ? DAYS : NON_SUNDAY_DAYS; }

// subjectId -> [facultyId, ...] qualified/previously-handled faculty for that subject.
function buildSubjectFacultyMap(){
  const map = {};
  state.faculty.forEach(f=>{
    f.subjectIds.forEach(sid=>{
      if(!map[sid]) map[sid] = [];
      map[sid].push(f.id);
    });
  });
  return map;
}

// `blocks` (from the Optimize Schedule tab, default 1) multiplies EVERY subject into that many
// independent, separately-scheduled copies — e.g. 3 parallel sections of the same course, each
// competing for its own room/day/time/faculty. subjectId (faculty qualification, cohort
// membership, color) stays the real subject's id, shared by every block; each block instead
// gets its own `instanceKey`, used only to keep that ONE block/section's own sessions spread
// across different days — so different blocks (and, for a room-capacity Lab split, different
// sections within a block) never block each other off a day the way same-subject sessions do.
function buildTasks(blocks){
  blocks = Math.max(1, parseInt(blocks,10) || 1);
  const tasks = [];
  const facultyMap = buildSubjectFacultyMap();
  const cohortGroups = buildCohortGroups(); // subjectId -> "program|yearLabel" cohort key, or absent
  state.subjects.forEach(s=>{
    const facultyIds = facultyMap[s.id] || []; // empty = no faculty-conflict check for this subject
    const cohortGroup = cohortGroups[s.id] || null; // must not overlap other required courses in the same program+year
    const isCohort = !!cohortGroup;
    const externalAssignment = !!s.externalAssignment; // true = no room/faculty, class hours only (TBA/TBD)
    const allowSunday = isSundayExemptSubject(s); // constraint #1: Sunday only for NST001/NST002
    for(let b=0;b<blocks;b++){
      // Schedule output (Room/Faculty/Student views, List View, CSV) shows the course CODE
      // only — not the full prospectus title — to keep the plotted tables from getting
      // crowded; subjectCodeLabel() resolves the linked prospectus course's code when there
      // is one, otherwise falls back to the subject's own name (already a code, manually).
      const code = subjectCodeLabel(s);
      const subjectName = blocks>1 ? `${code}-${b+1}` : code;
      if(s.isSplitPair){
        // One atomic task representing both 1.5h halves, placed on a matching day-pair at the same time.
        tasks.push({
          type: "paired",
          subjectId:s.id, subjectName, durationSlots:s.durationSlots, subjectType: s.type,
          size:s.size, color:s.color, dayPairPref:s.dayPairPref, blockIndex:b,
          sortWeight: s.durationSlots*2, facultyIds, isCohort, cohortGroup, externalAssignment, allowSunday,
          level: s.level==="GRAD" ? "GRAD" : "UG" // Faculty Load Units: which flat per-subject value this task counts toward a faculty member's total (see taskTeachingUnits)
        });
      } else {
        // Lab subjects split for room capacity produce 2 identical full-length sessions
        // (e.g. Section 1 / Section 2), each scheduled independently — no same-time/room/day
        // constraint between sections, so each gets its own instanceKey.
        for(let i=0;i<s.sessionsPerWeek;i++){
          const instanceKey = s.isCapacitySplit ? `${s.id}::b${b}::sec${i}` : `${s.id}::b${b}`;
          tasks.push({
            type:"single", subjectId:s.id, subjectName, durationSlots:s.durationSlots,
            size:s.size, color:s.color, sessionIndex:i, sortWeight:s.durationSlots, blockIndex:b,
            subjectType: s.type, labSection: s.isCapacitySplit ? (i+1) : null, instanceKey,
            facultyIds, isCohort, cohortGroup, externalAssignment, allowSunday,
            level: s.level==="GRAD" ? "GRAD" : "UG"
          });
        }
      }
    }
  });
  return tasks;
}

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// Among facultyIds, returns one at random who is free across all `days` for
// [start, start+durationSlots) — or null if none of them are free (meaning this
// slot can't be taught by anyone qualified and must be rejected as a candidate).
// `loadCtx` (optional — omitted entirely by the diagnostics-only callers, which just need a
// yes/no on time-feasibility) softly prefers whichever free, qualified faculty member would
// stay within their remaining teaching-load capacity (24 units minus their Admin/Research
// Load Units) if picked for this subject — never a hard filter, since going over 24 is
// allowed ("not advisable") rather than forbidden, so an over-cap faculty member is still
// used when they're the only one free.
function pickFreeFaculty(facultyIds, facultyOcc, days, start, durationSlots, loadCtx){
  const freeOnes = facultyIds.filter(fid=>{
    return days.every(day=>{
      const arr = facultyOcc[fid][day];
      for(let k=0;k<durationSlots;k++){ if(arr[start+k]) return false; }
      return true;
    });
  });
  if(freeOnes.length===0) return null;
  if(loadCtx){
    const within = freeOnes.filter(fid=>{
      const already = loadCtx.credited.has(fid+"|"+loadCtx.subjectId);
      const projected = (loadCtx.units[fid]||0) + (already ? 0 : loadCtx.unitValue);
      const max = loadCtx.maxUnits[fid];
      return max==null || projected <= max;
    });
    if(within.length>0) return within[Math.floor(Math.random()*within.length)];
  }
  return freeOnes[Math.floor(Math.random()*freeOnes.length)];
}

// Room Type is a hard constraint: "LEC" or "LAB" only ever hosts that one subject type;
// "BOTH" (default, incl. any room predating this field) hosts either.
function roomAllowsType(room, subjectType){
  const rt = room.roomType==="LEC"||room.roomType==="LAB" ? room.roomType : "BOTH";
  return rt==="BOTH" || rt===subjectType;
}

function findCandidates(room, day, durationSlots, occ, size, usedDaysForSubject, facultyIds, facultyOcc, isCohort, cohortOcc, subjectType, loadCtx){
  if(usedDaysForSubject.has(day)) return [];
  if(!roomAllowsType(room, subjectType)) return [];
  if(size && room.capacity && room.capacity < size) return [];
  // Shared-room cap: this session's slots would push the room's weekly booked total past the
  // usageLimitPercent budget it's allowed to claim — skip the room entirely for this task.
  if(computeRoomLoad(occ, room.id) + durationSlots > maxAllowedSlots(room)) return [];
  const avail = room.availability[day];
  const occArr = occ[room.id][day];
  const cohortArr = isCohort ? cohortOcc[day] : null;
  const out = [];
  for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
    let ok = true;
    for(let k=0;k<durationSlots;k++){
      if(!avail[start+k] || occArr[start+k]){ ok=false; break; }
      if(cohortArr && cohortArr[start+k]){ ok=false; break; } // a required course for the same regular-student year level already occupies this time
    }
    if(!ok) continue;
    let facultyId = null;
    if(facultyIds && facultyIds.length){
      facultyId = pickFreeFaculty(facultyIds, facultyOcc, [day], start, durationSlots, loadCtx);
      if(!facultyId) continue; // no qualified faculty free at this room/time — not a valid slot
    }
    let adj = 0;
    if(start>0 && occArr[start-1]) adj++;
    if(start+durationSlots<NUM_SLOTS && occArr[start+durationSlots]) adj++;
    const capWaste = (size && room.capacity) ? (room.capacity - size) : 0;
    out.push({ roomId:room.id, day, start, adj, capWaste, facultyId });
  }
  return out;
}

// External-Assignment subjects: room and faculty are handled by another college/department
// (TBA / TBD), so the optimizer only needs to find a free (day, start-slot) for the class
// hours themselves — no room availability/capacity, and no faculty check. The only remaining
// hard constraint is the shared regular-student cohort grid, so these still can't overlap
// another required course for the same year level.
function findScheduleOnlyCandidates(day, durationSlots, usedDaysForSubject, isCohort, cohortOcc){
  if(usedDaysForSubject.has(day)) return [];
  const cohortArr = isCohort ? cohortOcc[day] : null;
  const out = [];
  for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
    if(cohortArr){
      let ok = true;
      for(let k=0;k<durationSlots;k++){ if(cohortArr[start+k]){ ok=false; break; } }
      if(!ok) continue;
    }
    out.push({ day, start, adj:0, capWaste:0 });
  }
  return out;
}
function findScheduleOnlyPairedCandidates(pairKey, durationSlots, isCohort, cohortOcc){
  const [d1,d2] = DAY_PAIRS[pairKey];
  const cohort1 = isCohort ? cohortOcc[d1] : null, cohort2 = isCohort ? cohortOcc[d2] : null;
  const out = [];
  for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
    if(cohort1){
      let ok = true;
      for(let k=0;k<durationSlots;k++){ if(cohort1[start+k] || cohort2[start+k]){ ok=false; break; } }
      if(!ok) continue;
    }
    out.push({ pairKey, day1:d1, day2:d2, start, adj:0, capWaste:0 });
  }
  return out;
}

// Finds (start-slot) candidates in `room` for a paired subject on a specific day-pair,
// requiring BOTH days to be free/available at the same start slot (same time, same room),
// AND a qualified faculty member free on both days at that same time.
function findPairedCandidates(room, pairKey, durationSlots, occ, size, facultyIds, facultyOcc, isCohort, cohortOcc, subjectType, loadCtx){
  if(!roomAllowsType(room, subjectType)) return [];
  if(size && room.capacity && room.capacity < size) return [];
  // Same shared-room budget check as findCandidates, but a paired session books durationSlots
  // on BOTH days of the pair, so it costs durationSlots*2 against the room's weekly cap.
  if(computeRoomLoad(occ, room.id) + durationSlots*2 > maxAllowedSlots(room)) return [];
  const [d1,d2] = DAY_PAIRS[pairKey];
  const av1 = room.availability[d1], av2 = room.availability[d2];
  const occ1 = occ[room.id][d1], occ2 = occ[room.id][d2];
  const cohort1 = isCohort ? cohortOcc[d1] : null, cohort2 = isCohort ? cohortOcc[d2] : null;
  const out = [];
  for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
    let ok = true;
    for(let k=0;k<durationSlots;k++){
      if(!av1[start+k] || occ1[start+k] || !av2[start+k] || occ2[start+k]){ ok=false; break; }
      if(cohort1 && (cohort1[start+k] || cohort2[start+k])){ ok=false; break; }
    }
    if(!ok) continue;
    let facultyId = null;
    if(facultyIds && facultyIds.length){
      facultyId = pickFreeFaculty(facultyIds, facultyOcc, [d1,d2], start, durationSlots, loadCtx);
      if(!facultyId) continue;
    }
    let adj = 0;
    if(start>0 && (occ1[start-1] || occ2[start-1])) adj++;
    if(start+durationSlots<NUM_SLOTS && (occ1[start+durationSlots] || occ2[start+durationSlots])) adj++;
    const capWaste = (size && room.capacity) ? (room.capacity - size) : 0;
    out.push({ roomId:room.id, pairKey, day1:d1, day2:d2, start, adj, capWaste, facultyId });
  }
  return out;
}

/* ---------------------------------------------------------------------
   CONFLICT DIAGNOSTICS
   When a task can't be placed, figure out WHY by checking progressively
   looser feasibility levels (capacity -> static room availability -> room
   contention against other bookings -> same-day contention -> faculty
   contention) and reporting the first level that actually blocks it, so
   the user gets a specific, actionable reason instead of a generic
   "couldn't schedule" — and can tell at a glance whether it's a room
   problem or a faculty problem.
--------------------------------------------------------------------- */
function roomHasStaticBlock(room, durationSlots, excludeDays, days){
  return (days||DAYS).some(d=>{
    if(excludeDays && excludeDays.has(d)) return false;
    const avail = room.availability[d];
    for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
      let ok = true;
      for(let k=0;k<durationSlots;k++){ if(!avail[start+k]){ ok=false; break; } }
      if(ok) return true;
    }
    return false;
  });
}
function roomHasFreeBlock(room, durationSlots, occ, excludeDays, days){
  return (days||DAYS).some(d=>{
    if(excludeDays && excludeDays.has(d)) return false;
    const avail = room.availability[d], occArr = occ[room.id][d];
    for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
      let ok = true;
      for(let k=0;k<durationSlots;k++){ if(!avail[start+k] || occArr[start+k]){ ok=false; break; } }
      if(ok) return true;
    }
    return false;
  });
}
// Would booking costSlots more into this (possibly shared) room stay within its
// usageLimitPercent budget? Used to tell "genuinely no free time" apart from "free time
// exists, but this room has already given up its share to other bookings this week".
function roomWithinCap(occ, room, costSlots){
  return computeRoomLoad(occ, room.id) + costSlots <= maxAllowedSlots(room);
}
function facultyNamesFor(facultyIds){
  return facultyIds.map(id=>{ const f=state.faculty.find(x=>x.id===id); return f?f.name:null; }).filter(Boolean);
}
// Once room/time is known to be available on its own, isolate which of the two remaining
// hard constraints (faculty, regular-student cohort) is actually the blocker by checking
// each one independently (the other ignored) — so the diagnosis names the real cause
// instead of defaulting to "faculty" whenever a cohort conflict is the true reason.
function anyFreeIgnoringCohort(bigEnough, durationSlots, occ, usedDaysForSubject, facultyIds, facultyOcc, days){
  return bigEnough.some(room=> (days||DAYS).some(d=>{
    if(usedDaysForSubject.has(d)) return false;
    const avail = room.availability[d], occArr = occ[room.id][d];
    for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
      let ok = true;
      for(let k=0;k<durationSlots;k++){ if(!avail[start+k] || occArr[start+k]){ ok=false; break; } }
      if(!ok) continue;
      if(facultyIds && facultyIds.length && !pickFreeFaculty(facultyIds, facultyOcc, [d], start, durationSlots)) continue;
      return true;
    }
    return false;
  }));
}
function anyFreeIgnoringFaculty(bigEnough, durationSlots, occ, usedDaysForSubject, isCohort, cohortOcc, days){
  return bigEnough.some(room=> (days||DAYS).some(d=>{
    if(usedDaysForSubject.has(d)) return false;
    const avail = room.availability[d], occArr = occ[room.id][d];
    const cohortArr = isCohort ? cohortOcc[d] : null;
    for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
      let ok = true;
      for(let k=0;k<durationSlots;k++){
        if(!avail[start+k] || occArr[start+k]){ ok=false; break; }
        if(cohortArr && cohortArr[start+k]){ ok=false; break; }
      }
      if(ok) return true;
    }
    return false;
  }));
}
// "program|yearLabel" -> "Program — Year Level" for diagnostic messages.
function cohortGroupLabel(cohortGroup){
  if(!cohortGroup) return "the same regular-student cohort";
  return cohortGroup.split("|").join(" — ");
}
// The Regular-Student Schedule selector/grid is keyed by (cohortGroup, block) together, not
// just cohortGroup — with 2+ blocks, each block is a different sub-group of students (e.g.
// two parallel sections), so mixing their courses into one table would show a subject twice
// for no reason and falsely imply one student takes both. These two helpers convert between
// that composite key and its parts.
function cohortCompositeKey(group, blockIndex){ return group + "::b" + (blockIndex||0); }
function parseCohortComposite(key){
  const idx = key.lastIndexOf("::b");
  return { group: key.slice(0, idx), blockIndex: parseInt(key.slice(idx+3), 10) || 0 };
}
function diagnoseSingleTask(task, occ, usedDaysForSubject, isCohort, cohortOcc, facultyOcc){
  const size = task.size, durationSlots = task.durationSlots;
  const days = candidateDaysFor(task); // constraint #1: Sunday excluded unless NST001/NST002
  const typeOk = state.rooms.filter(r=> roomAllowsType(r, task.subjectType));
  if(typeOk.length===0){
    return { type:"room", text:`No room is set up to host ${task.subjectType==="LAB"?"Laboratory":"Lecture"} subjects — set a room's Room Type to "${task.subjectType==="LAB"?"LAB":"LEC"}" or "Both" in the Rooms tab.` };
  }
  const bigEnough = typeOk.filter(r => !size || !r.capacity || r.capacity>=size);
  if(bigEnough.length===0){
    const maxCap = typeOk.reduce((m,r)=> Math.max(m, r.capacity||0), 0);
    return { type:"room", text:`No room seats ${size} — the largest room available seats ${maxCap||0}. Add a bigger room or lower the class size.` };
  }
  if(!bigEnough.some(r=> roomHasStaticBlock(r, durationSlots, null, days))){
    const hrs = (durationSlots*SLOT_LEN/60);
    return { type:"room", text:`No room seating ${size||"enough students"} has a continuous ${hrs}-hour open block anywhere in its weekly availability — check Edit Availability for those rooms.` };
  }
  if(!bigEnough.some(r=> roomHasFreeBlock(r, durationSlots, occ, null, days))){
    return { type:"room", text:`Every room big enough for this session is already booked at all the times it's open long enough — add another suitably-sized room, or free up an existing booking.` };
  }
  if(!bigEnough.some(r=> roomWithinCap(occ, r, durationSlots) && roomHasFreeBlock(r, durationSlots, occ, null, days))){
    return { type:"room", text:`Free time exists, but every big-enough room has already reached its shared-usage cap (Allowable Usage %) for the week — raise that room's cap, or add another room.` };
  }
  if(!bigEnough.some(r=> roomHasFreeBlock(r, durationSlots, occ, usedDaysForSubject, days))){
    return { type:"room", text:`A free room/time exists, but only on a day this subject already has another session — reduce Sessions/Week, or widen room availability to more days.` };
  }
  const cohortOnlyOk = anyFreeIgnoringFaculty(bigEnough, durationSlots, occ, usedDaysForSubject, isCohort, cohortOcc, days);
  const facultyOnlyOk = anyFreeIgnoringCohort(bigEnough, durationSlots, occ, usedDaysForSubject, task.facultyIds, facultyOcc, days);
  if(!cohortOnlyOk){
    return { type:"student", text:`Room and time are free, but this required course would overlap another required course for ${cohortGroupLabel(task.cohortGroup)} — no time avoids conflicting with that cohort's other courses. Try adjusting the other course's schedule, or add another room/faculty to free up options.` };
  }
  if(!facultyOnlyOk){
    const names = facultyNamesFor(task.facultyIds);
    return { type:"faculty", text:`A suitable room and time are free, but every listed faculty member (${names.join(", ")}) is already booked at all of those times.` };
  }
  return { type: isCohort ? "student" : "faculty", text:`Room and time exist for the faculty schedule alone, and separately for ${cohortGroupLabel(task.cohortGroup)} alone, but no single slot satisfies both at once — free up either the faculty's schedule or that cohort's other courses.` };
}
function diagnosePairedTask(task, occ, isCohort, cohortOcc){
  const size = task.size, durationSlots = task.durationSlots;
  const pairKeys = task.dayPairPref === "AUTO" ? DAY_PAIR_ORDER : [task.dayPairPref];
  const pairLabels = pairKeys.map(pk=>DAY_PAIR_LABELS[pk]).join(", ");
  const typeOk = state.rooms.filter(r=> roomAllowsType(r, task.subjectType));
  if(typeOk.length===0){
    return { type:"room", text:`No room is set up to host ${task.subjectType==="LAB"?"Laboratory":"Lecture"} subjects — set a room's Room Type to "${task.subjectType==="LAB"?"LAB":"LEC"}" or "Both" in the Rooms tab.` };
  }
  const bigEnough = typeOk.filter(r => !size || !r.capacity || r.capacity>=size);
  if(bigEnough.length===0){
    const maxCap = typeOk.reduce((m,r)=> Math.max(m, r.capacity||0), 0);
    return { type:"room", text:`No room seats ${size} — the largest room available seats ${maxCap||0}. Add a bigger room or lower the class size.` };
  }
  function pairBlock(room, pk, withOcc, withCohort){
    const [d1,d2] = DAY_PAIRS[pk];
    const a1=room.availability[d1], a2=room.availability[d2];
    const o1 = withOcc ? occ[room.id][d1] : null, o2 = withOcc ? occ[room.id][d2] : null;
    const c1 = withCohort ? cohortOcc[d1] : null, c2 = withCohort ? cohortOcc[d2] : null;
    for(let start=0; start+durationSlots<=NUM_SLOTS; start++){
      let ok = true;
      for(let k=0;k<durationSlots;k++){
        if(!a1[start+k] || !a2[start+k] || (withOcc && (o1[start+k]||o2[start+k]))){ ok=false; break; }
        if(withCohort && (c1[start+k]||c2[start+k])){ ok=false; break; }
      }
      if(ok) return true;
    }
    return false;
  }
  if(!bigEnough.some(r=> pairKeys.some(pk=> pairBlock(r, pk, false, false)))){
    return { type:"room", text:`No room big enough has a matching open block on both days of its preferred day pair (${pairLabels}) — check room availability.` };
  }
  if(!bigEnough.some(r=> pairKeys.some(pk=> pairBlock(r, pk, true, false)))){
    return { type:"room", text:`Every room big enough is already booked at all matching same-time slots across its preferred day pair(s) (${pairLabels}) — add another room or free up a booking.` };
  }
  if(!bigEnough.some(r=> roomWithinCap(occ, r, durationSlots*2) && pairKeys.some(pk=> pairBlock(r, pk, true, false)))){
    return { type:"room", text:`A matching free time exists, but every big-enough room has already reached its shared-usage cap (Allowable Usage %) for the week — raise that room's cap, or add another room.` };
  }
  if(isCohort && !bigEnough.some(r=> pairKeys.some(pk=> pairBlock(r, pk, true, true)))){
    return { type:"student", text:`Room and time are free, but this required course would overlap another required course for ${cohortGroupLabel(task.cohortGroup)} on its preferred day pair (${pairLabels}) — no matching time avoids conflicting with that cohort's other courses.` };
  }
  const names = facultyNamesFor(task.facultyIds);
  return { type:"faculty", text:`A matching room and time are free on at least one preferred day pair (${pairLabels}), but every listed faculty member (${names.join(", ")}) is already booked at all of those times.` };
}

// External-Assignment tasks have no room/faculty constraint at all — with 7:30AM-9:00PM
// available every day, the only realistic reasons placement can fail are (a) the subject's
// own sessions have used up every day already, or (b) every remaining day/time overlaps
// another required course for the same regular-student year level.
function diagnoseScheduleOnlyTask(task, usedDaysForSubject, isCohort){
  const daysLeft = candidateDaysFor(task).filter(d=> !usedDaysForSubject.has(d));
  if(daysLeft.length===0){
    return { type:"student", text:`This subject already has a session on every day of the week — reduce Sessions/Week.` };
  }
  if(!isCohort){
    return { type:"student", text:`No time slot could be placed for this class-hours-only session — try again, or check Sessions/Week isn't higher than available days.` };
  }
  return { type:"student", text:`Room and faculty aren't required (External Assignment), but every remaining day/time overlaps another required course for ${cohortGroupLabel(task.cohortGroup)} — try adjusting the other course's schedule.` };
}
function diagnoseScheduleOnlyPairedTask(task, isCohort){
  const pairKeys = task.dayPairPref === "AUTO" ? DAY_PAIR_ORDER : [task.dayPairPref];
  const pairLabels = pairKeys.map(pk=>DAY_PAIR_LABELS[pk]).join(", ");
  return { type:"student", text:`Room and faculty aren't required (External Assignment), but no matching time on its preferred day pair (${pairLabels}) avoids overlapping another required course for ${cohortGroupLabel(task.cohortGroup)}.` };
}

// Safety net run on the GA's final result before anything is plotted: the decoder is built
// to be conflict-free by construction, but this independently re-checks every scheduled
// session for room double-bookings, faculty double-bookings, and regular-student
// (curriculum cohort) double-bookings. Anything that fails is pulled out of the plotted
// schedule and moved into the conflicts list for manual review — so only genuinely
// conflict-free sessions ever get plotted, no matter what produced them.
function validateAndSplitConflicts(result){
  const assignments = result.assignments;
  const overlaps = (a,b) => a.startSlot < (b.startSlot+b.durationSlots) && b.startSlot < (a.startSlot+a.durationSlots);

  function conflictSet(keyFn){
    const ids = new Set();
    const groups = {};
    assignments.forEach(a=>{
      const key = keyFn(a);
      if(key==null) return;
      (groups[key] = groups[key] || []).push(a);
    });
    Object.values(groups).forEach(list=>{
      for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++){
        if(overlaps(list[i], list[j])){ ids.add(list[i].id); ids.add(list[j].id); }
      }
    });
    return ids;
  }

  // External-Assignment sessions (roomId===TBA_ROOM_ID) don't occupy a real room, so several
  // of them legitimately sharing the same day/time is not a room double-booking.
  const roomConflictIds = conflictSet(a=> (a.roomId && a.roomId!==TBA_ROOM_ID) ? a.roomId+"|"+a.day : null);
  const facultyConflictIds = conflictSet(a=> a.facultyId ? a.facultyId+"|"+a.day : null);
  // Grouped by cohortGroup ("program|yearLabel") AND blockIndex, not just "isCohort" — two
  // cohort sessions only conflict if they belong to the SAME program+year (see
  // buildCohortGroups) AND the same block (different blocks are different student
  // sub-groups and are free to overlap each other).
  const cohortConflictIds = conflictSet(a=> a.cohortGroup ? a.cohortGroup+"|"+a.blockIndex+"|"+a.day : null);

  if(roomConflictIds.size===0 && facultyConflictIds.size===0 && cohortConflictIds.size===0) return result; // common case

  const newAssignments = [];
  const newUnscheduled = result.unscheduled.slice();
  assignments.forEach(a=>{
    const isRoomConflict = roomConflictIds.has(a.id);
    const isFacultyConflict = facultyConflictIds.has(a.id);
    const isCohortConflict = cohortConflictIds.has(a.id);
    if(!isRoomConflict && !isFacultyConflict && !isCohortConflict){ newAssignments.push(a); return; }
    const type = isRoomConflict ? "room" : (isCohortConflict ? "student" : "faculty");
    const parts = [];
    if(isRoomConflict) parts.push(`a room double-booking in ${a.roomName}`);
    if(isFacultyConflict) parts.push(`a faculty double-booking for ${a.facultyName||"the assigned faculty"}`);
    if(isCohortConflict) parts.push(`a regular-student schedule conflict with another required course for ${(a.cohortGroup||"").split("|").join(" — ")||"the same program/year level"}`);
    let text = `Detected ${parts.join(" and ")} on ${DAY_FULL[a.day]} at ${fmtTime(a.startMin)}. Pulled from the schedule for manual review.`;
    newUnscheduled.push({ subjectName:a.subjectName, sessionIndex:0, labSection:a.labSection, conflictType:type, conflictReason:text });
  });
  return Object.assign({}, result, { assignments:newAssignments, unscheduled:newUnscheduled, scheduledCount:newAssignments.length });
}

function runTrial(tasksOrder){
  const occ = {};
  state.rooms.forEach(r=>{
    occ[r.id] = {};
    DAYS.forEach(d=> occ[r.id][d] = new Array(NUM_SLOTS).fill(false));
  });
  const facultyOcc = {}; // facultyId -> day -> slot occupancy, shared across ALL rooms (one person, one place)
  state.faculty.forEach(f=>{
    facultyOcc[f.id] = {};
    DAYS.forEach(d=> facultyOcc[f.id][d] = new Array(NUM_SLOTS).fill(false));
  });
  // One occupancy grid PER regular-student cohort (year level) — every required course for a
  // given year level in the target semester must avoid every other required course for that
  // SAME year level, since one student takes them all at once. Different year levels get
  // their own independent grid, so (e.g.) a First Year course and a Second Year course never
  // block each other — they're different students, taking classes in parallel. Also split by
  // blockIndex: block 1 and block 2 represent different sub-groups of students within the
  // same cohort (e.g. two parallel sections), so they must NOT be forced to dodge each
  // other's courses — each block gets its own fully independent grid.
  const cohortOccByGroup = {};
  function groupOccFor(group, blockIndex){
    if(!group) return null;
    const key = group + "::b" + blockIndex;
    if(!cohortOccByGroup[key]){
      cohortOccByGroup[key] = {};
      DAYS.forEach(d=> cohortOccByGroup[key][d] = new Array(NUM_SLOTS).fill(false));
    }
    return cohortOccByGroup[key];
  }
  const usedDays = {}; // subjectId -> Set(day)
  const assignments = [];
  const unscheduled = [];
  let lateLabCount = 0; // Laboratory sessions that spilled past LAB_PREFERRED_END_MIN
  let fridayCount = 0; // sessions placed on Friday — discouraged for energy savings (constraint #4)

  // Total occupied slots per room so far this trial — used to bias placement toward
  // rooms already in use (maximize room utilization / minimize half-empty rooms).
  function roomLoad(roomId){ return computeRoomLoad(occ, roomId); }

  // Faculty Load Units — a soft preference, not a hard constraint (going over 24 is allowed,
  // just "not advisable"). facultyMaxUnits is fixed for the whole trial (admin/research load
  // doesn't change mid-decode); facultyTeachingUnits/facultyCredited accumulate as tasks get
  // assigned, crediting a faculty member once per distinct SUBJECT they end up teaching (a
  // subject's unit value describes the course itself, not each individual session/meeting).
  const facultyMaxUnits = {};
  state.faculty.forEach(f=> facultyMaxUnits[f.id] = Math.max(0, 24 - (f.adminResearchUnits||0)));
  const facultyTeachingUnits = {};
  const facultyCredited = new Set();
  function loadCtxFor(task){
    if(!task.facultyIds || !task.facultyIds.length) return null;
    return { subjectId: task.subjectId, unitValue: taskTeachingUnits(task), units: facultyTeachingUnits, credited: facultyCredited, maxUnits: facultyMaxUnits };
  }
  function creditFacultyLoad(fid, task){
    if(!fid) return;
    const key = fid+"|"+task.subjectId;
    if(facultyCredited.has(key)) return;
    facultyCredited.add(key);
    facultyTeachingUnits[fid] = (facultyTeachingUnits[fid]||0) + taskTeachingUnits(task);
  }

  tasksOrder.forEach(task=>{
    if(task.type === "paired"){
      if(task.externalAssignment){
        const groupOcc = groupOccFor(task.cohortGroup, task.blockIndex);
        const pairKeys = task.dayPairPref === "AUTO" ? DAY_PAIR_ORDER : [task.dayPairPref];
        let allCandidates = [];
        pairKeys.forEach(pk=>{
          allCandidates = allCandidates.concat(findScheduleOnlyPairedCandidates(pk, task.durationSlots, task.isCohort, groupOcc));
        });
        if(allCandidates.length===0){
          const reason = diagnoseScheduleOnlyPairedTask(task, task.isCohort);
          unscheduled.push({ subjectName:task.subjectName, sessionIndex:0, paired:true, conflictType:reason.type, conflictReason:reason.text });
          unscheduled.push({ subjectName:task.subjectName, sessionIndex:1, paired:true, conflictType:reason.type, conflictReason:reason.text });
          return;
        }
        const pairPriority = pk => pairKeys.indexOf(pk);
        allCandidates.sort((a,b)=>{
          const p = pairPriority(a.pairKey) - pairPriority(b.pairKey);
          return p || (Math.random()-0.5);
        });
        const topN = Math.min(3, allCandidates.length);
        const pick = Math.random() < 0.7 ? allCandidates[0] : allCandidates[Math.floor(Math.random()*topN)];
        if(pick.pairKey==="FSa") fridayCount++; // constraint #4: Fri/Sat pairing includes a Friday
        if(groupOcc){
          for(let k=0;k<task.durationSlots;k++){
            groupOcc[pick.day1][pick.start+k] = true;
            groupOcc[pick.day2][pick.start+k] = true;
          }
        }
        const pairLabel = DAY_PAIR_LABELS[pick.pairKey];
        [pick.day1, pick.day2].forEach(day=>{
          assignments.push({
            id: genId("asg"),
            subjectId: task.subjectId, subjectName: task.subjectName, color: task.color,
            facultyId: null, facultyName: "TBD",
            roomId: TBA_ROOM_ID, roomName: "TBA",
            day, startSlot: pick.start, durationSlots: task.durationSlots,
            startMin: SLOT_TIMES[pick.start], endMin: SLOT_TIMES[pick.start]+task.durationSlots*SLOT_LEN,
            paired:true, pairLabel, isCohort: task.isCohort, cohortGroup: task.cohortGroup, blockIndex: task.blockIndex, external:true
          });
        });
        return;
      }
      const groupOcc = groupOccFor(task.cohortGroup, task.blockIndex);
      const pairKeys = task.dayPairPref === "AUTO" ? DAY_PAIR_ORDER : [task.dayPairPref];
      let allCandidates = [];
      state.rooms.forEach(room=>{
        pairKeys.forEach(pk=>{
          allCandidates = allCandidates.concat(findPairedCandidates(room, pk, task.durationSlots, occ, task.size, task.facultyIds, facultyOcc, task.isCohort, groupOcc, task.subjectType, loadCtxFor(task)));
        });
      });

      if(allCandidates.length===0){
        // Report as two individual unscheduled sessions so totals stay consistent with sessionsPerWeek.
        const reason = diagnosePairedTask(task, occ, task.isCohort, groupOcc);
        unscheduled.push({ subjectName:task.subjectName, sessionIndex:0, paired:true, conflictType:reason.type, conflictReason:reason.text });
        unscheduled.push({ subjectName:task.subjectName, sessionIndex:1, paired:true, conflictType:reason.type, conflictReason:reason.text });
        return;
      }
      // Respect the preferred pair priority order first (1. Mon/Wed, 2. Tue/Thu, 3. Fri/Sat when AUTO),
      // then favor rooms already carrying load + tight packing (maximize utilization), then minimize wasted capacity.
      const pairPriority = pk => pairKeys.indexOf(pk);
      const loadCache = {};
      allCandidates.sort((a,b)=>{
        const p = pairPriority(a.pairKey) - pairPriority(b.pairKey);
        if(p) return p;
        const aLoad = (loadCache[a.roomId] ??= roomLoad(a.roomId));
        const bLoad = (loadCache[b.roomId] ??= roomLoad(b.roomId));
        const aScore = a.adj*10 + aLoad, bScore = b.adj*10 + bLoad;
        if(aScore !== bScore) return bScore - aScore;
        if(a.capWaste !== b.capWaste) return a.capWaste - b.capWaste;
        return Math.random()-0.5;
      });
      const topN = Math.min(3, allCandidates.length);
      const pick = Math.random() < 0.7 ? allCandidates[0] : allCandidates[Math.floor(Math.random()*topN)];
      if(pick.pairKey==="FSa") fridayCount++; // constraint #4: Fri/Sat pairing includes a Friday

      for(let k=0;k<task.durationSlots;k++){
        occ[pick.roomId][pick.day1][pick.start+k] = true;
        occ[pick.roomId][pick.day2][pick.start+k] = true;
        if(pick.facultyId){
          facultyOcc[pick.facultyId][pick.day1][pick.start+k] = true;
          facultyOcc[pick.facultyId][pick.day2][pick.start+k] = true;
        }
        if(groupOcc){
          groupOcc[pick.day1][pick.start+k] = true;
          groupOcc[pick.day2][pick.start+k] = true;
        }
      }
      creditFacultyLoad(pick.facultyId, task);
      const room = state.rooms.find(r=>r.id===pick.roomId);
      const faculty = pick.facultyId ? state.faculty.find(f=>f.id===pick.facultyId) : null;
      const pairLabel = DAY_PAIR_LABELS[pick.pairKey];
      [pick.day1, pick.day2].forEach(day=>{
        assignments.push({
          id: genId("asg"),
          subjectId: task.subjectId, subjectName: task.subjectName, color: task.color,
          facultyId: pick.facultyId, facultyName: faculty ? faculty.name : null,
          roomId: pick.roomId, roomName: room.name,
          day, startSlot: pick.start, durationSlots: task.durationSlots,
          startMin: SLOT_TIMES[pick.start], endMin: SLOT_TIMES[pick.start]+task.durationSlots*SLOT_LEN,
          paired:true, pairLabel, isCohort: task.isCohort, cohortGroup: task.cohortGroup, blockIndex: task.blockIndex
        });
      });
      return;
    }

    if(!usedDays[task.instanceKey]) usedDays[task.instanceKey] = new Set();

    if(task.externalAssignment){
      const groupOcc = groupOccFor(task.cohortGroup, task.blockIndex);
      let allCandidates = [];
      candidateDaysFor(task).forEach(day=>{
        allCandidates = allCandidates.concat(findScheduleOnlyCandidates(day, task.durationSlots, usedDays[task.instanceKey], task.isCohort, groupOcc));
      });
      if(allCandidates.length===0){
        const reason = diagnoseScheduleOnlyTask(task, usedDays[task.instanceKey], task.isCohort);
        unscheduled.push({
          subjectName: task.subjectName, sessionIndex: task.sessionIndex, labSection: task.labSection,
          conflictType: reason.type, conflictReason: reason.text
        });
        return;
      }
      // Friday is discouraged (energy savings, constraint #4) — soft preference only.
      allCandidates.sort((a,b)=> (a.day==="Fri"?1:0)-(b.day==="Fri"?1:0) || (Math.random()-0.5));
      const extTopN = Math.min(3, allCandidates.length);
      const pick = Math.random() < 0.7 ? allCandidates[0] : allCandidates[Math.floor(Math.random()*extTopN)];
      if(pick.day==="Fri") fridayCount++;
      if(groupOcc){
        for(let k=0;k<task.durationSlots;k++) groupOcc[pick.day][pick.start+k] = true;
      }
      usedDays[task.instanceKey].add(pick.day);
      const endMin = SLOT_TIMES[pick.start]+task.durationSlots*SLOT_LEN;
      assignments.push({
        id: genId("asg"),
        subjectId: task.subjectId, subjectName: task.subjectName, color: task.color,
        subjectType: task.subjectType, labSection: task.labSection,
        facultyId: null, facultyName: "TBD",
        roomId: TBA_ROOM_ID, roomName: "TBA",
        day: pick.day, startSlot: pick.start, durationSlots: task.durationSlots,
        startMin: SLOT_TIMES[pick.start], endMin: endMin, isCohort: task.isCohort, cohortGroup: task.cohortGroup, blockIndex: task.blockIndex, external:true
      });
      return;
    }

    const groupOcc = groupOccFor(task.cohortGroup, task.blockIndex);
    let allCandidates = [];
    state.rooms.forEach(room=>{
      candidateDaysFor(task).forEach(day=>{
        const cands = findCandidates(room, day, task.durationSlots, occ, task.size, usedDays[task.instanceKey], task.facultyIds, facultyOcc, task.isCohort, groupOcc, task.subjectType, loadCtxFor(task));
        allCandidates = allCandidates.concat(cands);
      });
    });

    if(allCandidates.length===0){
      const reason = diagnoseSingleTask(task, occ, usedDays[task.instanceKey], task.isCohort, groupOcc, facultyOcc);
      unscheduled.push({
        subjectName: task.subjectName, sessionIndex: task.sessionIndex, labSection: task.labSection,
        conflictType: reason.type, conflictReason: reason.text
      });
      return;
    }
    // Laboratory subjects: prefer a candidate that stays within 7:30AM-6:00PM as much as
    // possible (constraint #2); Friday is discouraged for energy savings (constraint #4).
    // Both are soft preferences only — a worse-but-only slot is still used, just sorted
    // after better ones.
    const isLab = task.subjectType === "LAB";
    const loadCache = {};
    allCandidates.sort((a,b)=>{
      if(isLab){
        const aLate = (SLOT_TIMES[a.start]+task.durationSlots*SLOT_LEN) > LAB_PREFERRED_END_MIN ? 1 : 0;
        const bLate = (SLOT_TIMES[b.start]+task.durationSlots*SLOT_LEN) > LAB_PREFERRED_END_MIN ? 1 : 0;
        if(aLate !== bLate) return aLate - bLate;
      }
      const aFri = a.day==="Fri" ? 1 : 0, bFri = b.day==="Fri" ? 1 : 0;
      if(aFri !== bFri) return aFri - bFri;
      const aLoad = (loadCache[a.roomId] ??= roomLoad(a.roomId));
      const bLoad = (loadCache[b.roomId] ??= roomLoad(b.roomId));
      const aScore = a.adj*10 + aLoad, bScore = b.adj*10 + bLoad;
      if(aScore !== bScore) return bScore - aScore;
      if(a.capWaste !== b.capWaste) return a.capWaste - b.capWaste;
      return Math.random()-0.5;
    });
    const topN = Math.min(3, allCandidates.length);
    const pick = Math.random() < 0.7 ? allCandidates[0] : allCandidates[Math.floor(Math.random()*topN)];
    if(pick.day==="Fri") fridayCount++;

    for(let k=0;k<task.durationSlots;k++){
      occ[pick.roomId][pick.day][pick.start+k] = true;
      if(pick.facultyId) facultyOcc[pick.facultyId][pick.day][pick.start+k] = true;
      if(groupOcc) groupOcc[pick.day][pick.start+k] = true;
    }
    creditFacultyLoad(pick.facultyId, task);
    usedDays[task.instanceKey].add(pick.day);
    const room = state.rooms.find(r=>r.id===pick.roomId);
    const faculty = pick.facultyId ? state.faculty.find(f=>f.id===pick.facultyId) : null;
    const endMin = SLOT_TIMES[pick.start]+task.durationSlots*SLOT_LEN;
    if(isLab && endMin > LAB_PREFERRED_END_MIN) lateLabCount++;
    assignments.push({
      id: genId("asg"),
      subjectId: task.subjectId, subjectName: task.subjectName, color: task.color,
      subjectType: task.subjectType, labSection: task.labSection,
      facultyId: pick.facultyId, facultyName: faculty ? faculty.name : null,
      roomId: pick.roomId, roomName: room.name,
      day: pick.day, startSlot: pick.start, durationSlots: task.durationSlots,
      startMin: SLOT_TIMES[pick.start], endMin: endMin, isCohort: task.isCohort, cohortGroup: task.cohortGroup, blockIndex: task.blockIndex
    });
  });

  // Room-utilization metrics: gapScore = total idle slots trapped between the first and
  // last booking of each room-day (lower = tighter packing); activeRoomDayCount = how many
  // distinct room-days got used at all (lower = usage concentrated into fewer room-days
  // instead of spread thin) — both feed the "maximize room utilization" objective.
  let gapScore = 0;
  let activeRoomDayCount = 0;
  state.rooms.forEach(r=>{
    DAYS.forEach(d=>{
      const arr = occ[r.id][d];
      let first=-1, last=-1, count=0;
      arr.forEach((v,i)=>{ if(v){ if(first===-1) first=i; last=i; count++; } });
      if(first!==-1){ gapScore += (last-first+1-count); activeRoomDayCount++; }
    });
  });

  // Constraint #3: does this faculty member have at least one of the two break windows free
  // on every day? Constraint #4: how much idle time sits between their first and last class
  // of each day (e.g. a 7:30AM class then nothing again until 6PM) — same "trapped idle
  // slots" measure as the room gapScore above, just applied per faculty member per day.
  let facultyNoBreakCount = 0;
  let facultyGapScore = 0;
  state.faculty.forEach(f=>{
    const occByDay = facultyOcc[f.id];
    const hasBreak = FACULTY_BREAK_WINDOWS.some(w=> DAYS.every(d=> w.slots.every(i=> !occByDay[d][i])));
    if(!hasBreak) facultyNoBreakCount++;
    DAYS.forEach(d=>{
      const arr = occByDay[d];
      let first=-1, last=-1, count=0;
      arr.forEach((v,i)=>{ if(v){ if(first===-1) first=i; last=i; count++; } });
      if(first!==-1) facultyGapScore += (last-first+1-count);
    });
  });

  return { assignments, unscheduled, scheduledCount: assignments.length, gapScore, activeRoomDayCount, lateLabCount, fridayCount, facultyNoBreakCount, facultyGapScore };
}

/* ---------------------------------------------------------------------
   GENETIC ALGORITHM OPERATORS (permutation encoding over task order)
--------------------------------------------------------------------- */

// Fitness: sessions scheduled dominates everything (an empty slot is always worse than
// any packing/timing imperfection), then room utilization (tight packing + fewer
// half-empty room-days), then keeping Laboratory sessions within 7:30AM-6:00PM (constraint
// #2), minimizing Friday sessions (energy savings, constraint #4), giving each faculty
// member a free 10:30-12:00/12:00-1:30 break (constraint #3), and tightening each faculty
// member's daily schedule to avoid huge gaps like a 7:30AM class then nothing until 6PM
// (constraint #4b).
function scoreResult(result){
  return result.scheduledCount * 100000
       - result.gapScore * 3
       - result.activeRoomDayCount * 6
       - result.lateLabCount * 25
       - result.fridayCount * 10
       - result.facultyNoBreakCount * 15
       - result.facultyGapScore * 4;
}

function tournamentSelect(evaluated, k){
  let picked = null;
  for(let i=0;i<k;i++){
    const cand = evaluated[Math.floor(Math.random()*evaluated.length)];
    if(!picked || cand.fitness > picked.fitness) picked = cand;
  }
  return picked;
}

// Order Crossover (OX): copies a random slice from parent A as-is, then fills the
// remaining positions with parent B's genes in their relative order, skipping
// whatever parent A's slice already contributed — always yields a valid permutation.
function orderCrossover(parentA, parentB){
  const n = parentA.length;
  const child = new Array(n).fill(null);
  let i = Math.floor(Math.random()*n), j = Math.floor(Math.random()*n);
  if(i>j){ const tmp=i; i=j; j=tmp; }
  const usedIds = new Set();
  for(let k=i;k<=j;k++){ child[k] = parentA[k]; usedIds.add(parentA[k].__gaId); }
  let pos = (j+1)%n;
  for(let k=0;k<n;k++){
    const cand = parentB[(j+1+k)%n];
    if(!usedIds.has(cand.__gaId)){
      child[pos] = cand;
      usedIds.add(cand.__gaId);
      pos = (pos+1)%n;
    }
  }
  return child;
}

// Swap mutation: exchange a couple of random positions — standard, minimally-disruptive
// mutation operator for permutation-encoded GAs.
function swapMutate(order){
  const a = order.slice();
  const swaps = 1 + Math.floor(Math.random()*2); // 1-2 swaps
  for(let s=0;s<swaps;s++){
    const i = Math.floor(Math.random()*a.length);
    const j = Math.floor(Math.random()*a.length);
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

// Yields control back to the browser (lets the progress modal repaint) between generations.
function nextTick(){ return new Promise(resolve => setTimeout(resolve, 0)); }

// optimizeSchedule is async so it can pause between generations and let the UI update a
// live progress/convergence view. `onProgress`, if given, is called after every generation
// (including the seed generation) with a snapshot of the run so far.
async function optimizeSchedule(onProgress){
  if(state.subjects.length===0) return null;
  // Rooms are only a hard requirement when some subject actually needs one — an all-External-
  // Assignment roster is schedulable with zero rooms defined.
  const needsRoom = state.subjects.some(s=>!s.externalAssignment);
  if(needsRoom && state.rooms.length===0) return null;
  const blocksUsed = Math.max(1, parseInt(state.blocks,10) || 1);
  const baseTasks = buildTasks(blocksUsed);
  if(baseTasks.length===0) return null;
  baseTasks.forEach((t,i)=> t.__gaId = i);
  const totalTasks = baseTasks.length;

  function decode(order){
    const result = runTrial(order);
    result.fitness = scoreResult(result);
    return result;
  }
  function isPerfect(r){
    return r.scheduledCount===totalTasks && r.gapScore===0 && r.lateLabCount===0;
  }

  // GA parameters auto-scale with problem complexity — more rooms widen the search space
  // per task, more faculty adds extra conflict constraints, more subjects/sessions means
  // more genes to coordinate, and more regular-student cohort constraints (one independent
  // shared grid per program+year-level in the target term — a 4-year program's term has 4 of
  // these running at once, each with its own courses contending for the same students' time)
  // add real combinatorial difficulty on top — so harder problems automatically get a bigger
  // population, more generations, and a larger time budget, with no input needed from the user.
  const numRooms = state.rooms.length;
  const numFaculty = state.faculty.length;
  const numSubjects = state.subjects.length;
  const numCohortTasks = baseTasks.filter(t=>t.isCohort).length;
  // Distinct (cohortGroup, block) pairs — each is its own independent occupancy grid now.
  const numCohortGroups = new Set(baseTasks.filter(t=>t.isCohort).map(t=>t.cohortGroup+"::b"+t.blockIndex)).size;
  const complexity = totalTasks * (1 + Math.log2(numRooms + 1)) + numFaculty*3 + numSubjects + numCohortTasks*1.5 + numCohortGroups*4;
  const popSize = clamp(Math.round(complexity*1.5), 20, 150);
  const maxGenerations = clamp(Math.round(complexity*2.2), 25, 300);
  const eliteCount = Math.max(2, Math.round(popSize*0.08));
  const mutationRate = 0.25;
  const tournamentK = 3;
  const timeBudgetMs = clamp(1500 + complexity*40, 1500, 6000);

  // Seed the initial population with one heuristic ordering (most-constrained-first —
  // longest weekly duration, then largest class size) plus random permutations, so the
  // GA never starts worse than the old greedy-with-restarts baseline.
  const heuristicOrder = baseTasks.slice().sort((a,b)=>
    (b.sortWeight - a.sortWeight) || ((b.size||0)-(a.size||0))
  );
  let population = [heuristicOrder];
  while(population.length < popSize) population.push(shuffle(baseTasks));

  let evaluated = population.map(order=>{
    const result = decode(order);
    return { order, result, fitness: result.fitness };
  });
  evaluated.sort((a,b)=> b.fitness - a.fitness);
  let best = evaluated[0];

  function report(genCount, done){
    if(!onProgress) return;
    // totalSessions counts actual class SESSIONS (a paired task = 2 sessions), matching
    // what scheduledCount/unscheduled.length count — totalTasks (chromosome length) is a
    // different unit and would under-count whenever any paired subjects are involved.
    const totalSessions = best.result.scheduledCount + best.result.unscheduled.length;
    const studentConflicts = best.result.unscheduled.filter(u=>u.conflictType==="student").length;
    onProgress({
      generation: genCount, maxGenerations, popSize, totalTasks, totalSessions, done,
      fitness: best.fitness,
      scheduledCount: best.result.scheduledCount,
      gapScore: best.result.gapScore,
      activeRoomDayCount: best.result.activeRoomDayCount,
      lateLabCount: best.result.lateLabCount,
      fridayCount: best.result.fridayCount,
      facultyNoBreakCount: best.result.facultyNoBreakCount,
      facultyGapScore: best.result.facultyGapScore,
      cohortGroups: numCohortGroups,
      studentConflicts
    });
  }

  const start = performance.now();
  let genCount = 1; // the seed generation above already counts as generation 1
  report(genCount, false);
  await nextTick();

  for(let gen=0; gen<maxGenerations; gen++){
    if(isPerfect(best.result)) break;
    if(performance.now() - start > timeBudgetMs) break;

    const nextPop = [];
    for(let i=0;i<eliteCount && i<evaluated.length;i++) nextPop.push(evaluated[i].order.slice());
    while(nextPop.length < popSize){
      const parentA = tournamentSelect(evaluated, tournamentK);
      const parentB = tournamentSelect(evaluated, tournamentK);
      let child = orderCrossover(parentA.order, parentB.order);
      if(Math.random() < mutationRate) child = swapMutate(child);
      nextPop.push(child);
    }

    population = nextPop;
    evaluated = population.map(order=>{
      const result = decode(order);
      return { order, result, fitness: result.fitness };
    });
    evaluated.sort((a,b)=> b.fitness - a.fitness);
    if(evaluated[0].fitness > best.fitness) best = evaluated[0];
    genCount = gen+2;
    report(genCount, false);
    await nextTick();
  }
  best.result.generationsRun = genCount;
  best.result.populationSize = popSize;
  best.result.blocksUsed = blocksUsed;
  report(genCount, true);
  return best.result;
}

/* ---------------------------------------------------------------------
   SCHEDULE RENDERING
--------------------------------------------------------------------- */
let scheduleView = "grid"; // "grid" | "faculty" | "cohort" | "list"
let scheduleRoomId = null;
let scheduleFacultyId = null;
let scheduleCohortGroup = null;

function renderScheduleTab(){
  const container = document.getElementById("schedule-results");
  const sched = state.schedule;

  if(!sched){
    container.innerHTML = `<div class="panel"><div class="empty">No schedule yet. Add rooms &amp; subjects, then click "Optimize Scheduling".</div></div>`;
    return;
  }

  const total = sched.assignments.length + sched.unscheduled.length;
  let html = "";

  html += `<div class="summary-bar">
    <div class="summary-item hero"><div class="label">Sessions Scheduled</div><b>${sched.assignments.length} / ${total}</b></div>
    <div class="summary-item"><div class="label">Rooms</div><b>${state.rooms.length}</b></div>
    <div class="summary-item"><div class="label">Subjects</div><b>${state.subjects.length}</b></div>
  </div>`;

  if(sched.unscheduled.length>0){
    const label = u => `${escapeHtml(u.subjectName)} — ${u.labSection?`LAB Section ${u.labSection}`:`session ${u.sessionIndex+1}`}${u.paired?" (paired)":""}`;
    const roomConflicts = sched.unscheduled.filter(u=> u.conflictType!=="faculty" && u.conflictType!=="student");
    const facultyConflicts = sched.unscheduled.filter(u=> u.conflictType==="faculty");
    const studentConflicts = sched.unscheduled.filter(u=> u.conflictType==="student");
    html += `<div class="panel conflict-panel">
      <h2>⚠️ Scheduling Conflicts (${sched.unscheduled.length})</h2>
      <p class="sub">These sessions couldn't be placed automatically. Room, faculty, and regular-student issues are listed separately so you can address each manually — then click Optimize Scheduling again.</p>
      ${roomConflicts.length ? `<div class="conflict-group">
        <h3>🏫 Room Conflicts (${roomConflicts.length})</h3>
        <ul>${roomConflicts.map(u=>`<li><b>${label(u)}</b><div class="conflict-reason">${escapeHtml(u.conflictReason||"No free matching room/time slot was found.")}</div></li>`).join("")}</ul>
      </div>` : ""}
      ${facultyConflicts.length ? `<div class="conflict-group">
        <h3>👤 Faculty Conflicts (${facultyConflicts.length})</h3>
        <ul>${facultyConflicts.map(u=>`<li><b>${label(u)}</b><div class="conflict-reason">${escapeHtml(u.conflictReason||"No qualified faculty member was free.")}</div></li>`).join("")}</ul>
      </div>` : ""}
      ${studentConflicts.length ? `<div class="conflict-group">
        <h3>🎓 Regular-Student Schedule Conflicts (${studentConflicts.length})</h3>
        <ul>${studentConflicts.map(u=>`<li><b>${label(u)}</b><div class="conflict-reason">${escapeHtml(u.conflictReason||"Conflicts with another required course in the same program/year level.")}</div></li>`).join("")}</ul>
      </div>` : ""}
    </div>`;
  }

  html += `<div class="panel no-print">
    <div class="sched-toolbar" style="margin-bottom:0;">
      <div class="field">
        <label>View</label>
        <select id="view-mode-select" style="min-width:170px;">
          <option value="grid" ${scheduleView==="grid"?"selected":""}>Room Timetable</option>
          <option value="faculty" ${scheduleView==="faculty"?"selected":""}>Faculty Schedule</option>
          <option value="cohort" ${scheduleView==="cohort"?"selected":""}>Regular-Student Schedule</option>
          <option value="list" ${scheduleView==="list"?"selected":""}>List View</option>
        </select>
      </div>
      <div class="field" id="room-select-field" style="${scheduleView==="grid"?"":"display:none;"}">
        <label>Room</label>
        <select id="sched-room-select" style="min-width:160px;"></select>
      </div>
      <div class="field" id="faculty-select-field" style="${scheduleView==="faculty"?"":"display:none;"}">
        <label>Faculty</label>
        <select id="sched-faculty-select" style="min-width:180px;"></select>
      </div>
      <div class="field" id="cohort-select-field" style="${scheduleView==="cohort"?"":"display:none;"}">
        <label>Regular-Student Cohort</label>
        <select id="sched-cohort-select" style="min-width:220px;"></select>
      </div>
      <button class="btn btn-ghost" id="print-btn" style="align-self:flex-end;">🖨 Print</button>
      <button class="btn btn-ghost" id="csv-btn" style="align-self:flex-end;">⬇ Export CSV</button>
    </div>
  </div>`;

  html += `<div class="panel" id="sched-view-panel"></div>`;

  container.innerHTML = html;

  document.getElementById("view-mode-select").addEventListener("change", (e)=>{
    scheduleView = e.target.value;
    renderScheduleTab();
    trackEvent("switchScheduleView", { extra:{ view: scheduleView } });
  });
  document.getElementById("print-btn").addEventListener("click", ()=>{
    window.print();
    trackEvent("printSchedule", { extra:{ view: scheduleView } });
  });
  document.getElementById("csv-btn").addEventListener("click", ()=>{
    exportCsv();
    trackEvent("exportScheduleCsv", { extra:{ view: scheduleView } });
  });

  const roomSelect = document.getElementById("sched-room-select");
  if(roomSelect){
    // External-Assignment sessions (TBA/TBD, no real room) get their own virtual "room" entry
    // in the picker so they're still visible in the Room Timetable view, not just List View.
    const hasExternal = sched.assignments.some(a=> a.roomId===TBA_ROOM_ID);
    let optionsHtml = state.rooms.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("");
    if(hasExternal) optionsHtml += `<option value="${TBA_ROOM_ID}">🏢 ${escapeHtml(TBA_ROOM_NAME)}</option>`;
    roomSelect.innerHTML = optionsHtml;
    const validIds = new Set(state.rooms.map(r=>r.id));
    if(hasExternal) validIds.add(TBA_ROOM_ID);
    if(!scheduleRoomId || !validIds.has(scheduleRoomId)) scheduleRoomId = state.rooms[0] ? state.rooms[0].id : (hasExternal ? TBA_ROOM_ID : null);
    roomSelect.value = scheduleRoomId;
    roomSelect.addEventListener("change", (e)=>{ scheduleRoomId = e.target.value; renderScheduleView(); });
  }

  const facultySelect = document.getElementById("sched-faculty-select");
  if(facultySelect){
    facultySelect.innerHTML = state.faculty.map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("");
    const validFacIds = new Set(state.faculty.map(f=>f.id));
    if(!scheduleFacultyId || !validFacIds.has(scheduleFacultyId)) scheduleFacultyId = state.faculty[0] ? state.faculty[0].id : null;
    if(scheduleFacultyId) facultySelect.value = scheduleFacultyId;
    facultySelect.addEventListener("change", (e)=>{ scheduleFacultyId = e.target.value; renderScheduleView(); });
  }

  const cohortSelect = document.getElementById("sched-cohort-select");
  if(cohortSelect){
    // Only cohorts that actually have at least one scheduled (plotted) session — a cohort
    // whose every course conflicted has nothing to show on a grid anyway. With 2+ blocks,
    // each (cohortGroup, block) pair gets its own entry — see cohortCompositeKey().
    const blocksUsed = sched.blocksUsed || 1;
    const seen = new Set();
    const entries = [];
    sched.assignments.filter(a=>a.cohortGroup).forEach(a=>{
      const key = cohortCompositeKey(a.cohortGroup, a.blockIndex);
      if(seen.has(key)) return;
      seen.add(key);
      const label = blocksUsed>=2 ? `${cohortGroupLabel(a.cohortGroup)} (Block ${(a.blockIndex||0)+1})` : cohortGroupLabel(a.cohortGroup);
      entries.push({ key, label });
    });
    entries.sort((a,b)=> a.label.localeCompare(b.label));
    const cohortKeys = entries.map(e=>e.key);
    cohortSelect.innerHTML = entries.map(e=>`<option value="${escapeHtml(e.key)}">${escapeHtml(e.label)}</option>`).join("");
    if(!scheduleCohortGroup || !cohortKeys.includes(scheduleCohortGroup)) scheduleCohortGroup = cohortKeys[0] || null;
    if(scheduleCohortGroup) cohortSelect.value = scheduleCohortGroup;
    cohortSelect.addEventListener("change", (e)=>{ scheduleCohortGroup = e.target.value; renderScheduleView(); });
  }

  renderScheduleView();
}

function renderScheduleView(){
  const panel = document.getElementById("sched-view-panel");
  const sched = state.schedule;
  if(!panel || !sched) return;

  if(scheduleView === "list"){
    panel.innerHTML = renderListView(sched);
    return;
  }

  if(scheduleView === "faculty"){
    if(state.faculty.length===0){
      panel.innerHTML = '<div class="empty">No faculty added yet — add faculty in the Faculty tab to see their individual schedules here.</div>';
      return;
    }
    const faculty = state.faculty.find(f=>f.id===scheduleFacultyId) || state.faculty[0];
    panel.innerHTML = renderFacultyGrid(faculty, sched);
    return;
  }

  if(scheduleView === "cohort"){
    const cohortKeys = Array.from(new Set(sched.assignments.filter(a=>a.cohortGroup).map(a=> cohortCompositeKey(a.cohortGroup, a.blockIndex))));
    if(cohortKeys.length===0){
      panel.innerHTML = '<div class="empty">No regular-student cohorts in this schedule — set a Target Semester (above) and link subjects to prospectus courses, then optimize again.</div>';
      return;
    }
    const key = cohortKeys.includes(scheduleCohortGroup) ? scheduleCohortGroup : cohortKeys[0];
    panel.innerHTML = renderCohortGrid(key, sched);
    return;
  }

  if(scheduleRoomId === TBA_ROOM_ID){
    // Virtual "room" — fully open (no real availability grid, just the standard time window)
    // — for viewing External-Assignment sessions on the same grid layout as a real room.
    const tbaRoom = { id: TBA_ROOM_ID, name: TBA_ROOM_NAME, capacity: null, availability: makeAvailability() };
    panel.innerHTML = renderRoomGrid(tbaRoom, sched);
    return;
  }
  const room = state.rooms.find(r=>r.id===scheduleRoomId) || state.rooms[0];
  if(!room){ panel.innerHTML = '<div class="empty">No rooms.</div>'; return; }
  panel.innerHTML = renderRoomGrid(room, sched);
}

// Shared weekly grid renderer behind all three grid-shaped views (Room Timetable, Faculty
// Schedule, Regular-Student Schedule) — takes a list of assignments already scoped to one
// room/faculty/cohort and lays them out on the standard 7:30 AM–9:00 PM grid. `availability`
// (per-day open/closed array), when given, grays out closed slots the way a room's own hours
// do; faculty/cohort views have no such concept and just leave every non-booked cell free.
// `tagFlags` controls which per-session badges are worth repeating in this particular view —
// e.g. a faculty member's own grid doesn't need to relabel their name in every cell, but does
// need the room name since their sessions span multiple rooms.
function renderScheduleGrid(title, subtitleHtml, assignments, availability, tagFlags){
  tagFlags = tagFlags || {};
  const grid = {};
  DAYS.forEach(d=> grid[d] = new Array(NUM_SLOTS).fill(null));

  assignments.forEach(a=>{
    grid[a.day][a.startSlot] = { type:"start", a };
    for(let k=1;k<a.durationSlots;k++) grid[a.day][a.startSlot+k] = { type:"covered" };
  });
  if(availability){
    for(let i=0;i<NUM_SLOTS;i++){
      DAYS.forEach(d=>{
        if(grid[d][i]===null && !availability[d][i]) grid[d][i] = { type:"unavail" };
      });
    }
  }

  let html = `<h2 style="margin-top:0;">${title}</h2>`;
  if(subtitleHtml) html += subtitleHtml;
  html += `<div style="overflow-x:auto;"><table class="sched-grid"><thead><tr><th class="timecol"></th>${DAYS.map(d=>`<th>${d}</th>`).join("")}</tr></thead><tbody>`;

  for(let i=0;i<NUM_SLOTS;i++){
    html += `<tr><td class="timecol">${slotLabel(i)}</td>`;
    DAYS.forEach(d=>{
      const cell = grid[d][i];
      if(cell && cell.type==="covered"){ return; } // skip, covered by rowspan above
      if(cell && cell.type==="start"){
        const a = cell.a;
        const labTag = a.labSection ? `<div style="margin-top:3px;"><span class="tag-lab">LAB · Section ${a.labSection}</span></div>` : "";
        const pairTag = a.paired ? `<div style="margin-top:3px;"><span class="tag-pair">⇄ ${a.pairLabel}</span></div>` : "";
        const roomTag = tagFlags.showRoom && a.roomName ? `<div style="margin-top:3px;"><span class="tag-faculty">🏫 ${escapeHtml(a.roomName)}</span></div>` : "";
        const facTag = tagFlags.showFaculty && a.facultyName ? `<div style="margin-top:3px;"><span class="tag-faculty">👤 ${escapeHtml(a.facultyName)}</span></div>` : "";
        const cohortTag = tagFlags.showCohort && a.isCohort ? `<div style="margin-top:3px;"><span class="tag-lec" title="${escapeHtml(cohortGroupLabel(a.cohortGroup))}">🎓 required</span></div>` : "";
        const externalTag = a.external ? `<div style="margin-top:3px;"><span class="tag-external">🏢 external</span></div>` : "";
        html += `<td class="slot-booked" rowspan="${a.durationSlots}" style="background:${a.color}">${escapeHtml(a.subjectName)}<div class="t">${fmtTime(a.startMin)}–${fmtTime(a.endMin)}</div>${pairTag}${labTag}${roomTag}${facTag}${cohortTag}${externalTag}</td>`;
      } else if(cell && cell.type==="unavail"){
        html += `<td class="slot-unavail"></td>`;
      } else {
        html += `<td class="slot-free"></td>`;
      }
    });
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function renderRoomGrid(room, sched){
  const assignments = sched.assignments.filter(a=>a.roomId===room.id);
  const title = `${escapeHtml(room.name)}${room.capacity?` <span style="color:var(--text-dim);font-weight:400;font-size:13px;">(capacity ${room.capacity})</span>`:""}`;
  return renderScheduleGrid(title, "", assignments, room.availability, { showFaculty:true, showCohort:true });
}

function renderFacultyGrid(faculty, sched){
  const assignments = sched.assignments.filter(a=>a.facultyId===faculty.id);
  const title = `👤 ${escapeHtml(faculty.name)}`;
  const subtitle = `<p class="sub">${assignments.length} session${assignments.length===1?"":"s"} this week.</p>`;
  return renderScheduleGrid(title, subtitle, assignments, null, { showRoom:true, showCohort:true });
}

// `cohortKey` is the composite (cohortGroup, block) key from cohortCompositeKey() — with 2+
// blocks each block gets its own table so a subject never appears twice for two different
// student sub-groups (see the comment on cohortCompositeKey).
function renderCohortGrid(cohortKey, sched){
  const { group, blockIndex } = parseCohortComposite(cohortKey);
  const assignments = sched.assignments.filter(a=> a.cohortGroup===group && (a.blockIndex||0)===blockIndex);
  const blocksUsed = sched.blocksUsed || 1;
  const blockSuffix = blocksUsed>=2 ? ` (Block ${blockIndex+1})` : "";
  const title = `🎓 ${escapeHtml(cohortGroupLabel(group))}${blockSuffix} — Regular Students`;
  const subtitle = `<p class="sub">${assignments.length} required session${assignments.length===1?"":"s"} this week — every course a regular student in this ${blocksUsed>=2?"block":"cohort"} takes.</p>`;
  return renderScheduleGrid(title, subtitle, assignments, null, { showRoom:true, showFaculty:true });
}

function renderListView(sched){
  if(sched.assignments.length===0) return '<div class="empty">No sessions scheduled.</div>';
  const sorted = sched.assignments.slice().sort((a,b)=>
    DAYS.indexOf(a.day)-DAYS.indexOf(b.day) || a.startSlot-b.startSlot || a.roomName.localeCompare(b.roomName)
  );
  let html = `<table class="list-table"><thead><tr><th>Subject</th><th>Faculty</th><th>Room</th><th>Day</th><th>Time</th></tr></thead><tbody>`;
  sorted.forEach(a=>{
    html += `<tr>
      <td><span class="dot" style="background:${a.color}"></span>${escapeHtml(a.subjectName)}${a.paired?` <span class="tag-pair">⇄ ${a.pairLabel}</span>`:""}${a.labSection?` <span class="tag-lab">LAB · Section ${a.labSection}</span>`:""}${a.isCohort?` <span class="tag-lec" title="${escapeHtml(cohortGroupLabel(a.cohortGroup))}">🎓 ${escapeHtml(cohortGroupLabel(a.cohortGroup))}</span>`:""}${a.external?` <span class="tag-external">🏢 external</span>`:""}</td>
      <td>${a.facultyName ? escapeHtml(a.facultyName) : `<span class="tag-faculty on-light">unassigned</span>`}</td>
      <td>${escapeHtml(a.roomName)}</td>
      <td>${DAY_FULL[a.day]}</td>
      <td>${fmtTime(a.startMin)} – ${fmtTime(a.endMin)}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

function slugify(s){
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"") || "item";
}

// Exports whatever the current View is actually showing — the full list for List View, or
// just the selected room/faculty member/cohort's own sessions for the 3 grid views — so the
// downloaded file matches what's on screen (and what Print would produce) rather than always
// dumping everything regardless of what's being looked at.
function exportCsv(){
  const sched = state.schedule;
  if(!sched || sched.assignments.length===0){ alert("No scheduled sessions to export yet."); return; }

  let assignments = sched.assignments;
  let filename = "schedule-all.csv";
  let scopeLabel = "";

  // If the view is scoped to a room/faculty/cohort, the selection must still resolve to
  // something real — a stale reference (e.g. the selected room/faculty was deleted, or no
  // cohort exists) must never silently fall back to exporting everything unscoped under a
  // misleadingly generic filename; tell the user and stop instead.
  if(scheduleView === "grid"){
    if(scheduleRoomId === TBA_ROOM_ID){
      assignments = assignments.filter(a=>a.roomId===TBA_ROOM_ID);
      filename = "schedule-room-tba.csv";
      scopeLabel = TBA_ROOM_NAME;
    } else {
      const room = state.rooms.find(r=>r.id===scheduleRoomId);
      if(!room){ alert("No room is selected — pick a room from the dropdown first."); return; }
      assignments = assignments.filter(a=>a.roomId===room.id);
      filename = `schedule-room-${slugify(room.name)}.csv`;
      scopeLabel = room.name;
    }
  } else if(scheduleView === "faculty"){
    const faculty = state.faculty.find(f=>f.id===scheduleFacultyId);
    if(!faculty){ alert("No faculty member is selected — add a faculty member first."); return; }
    assignments = assignments.filter(a=>a.facultyId===faculty.id);
    filename = `schedule-faculty-${slugify(faculty.name)}.csv`;
    scopeLabel = faculty.name;
  } else if(scheduleView === "cohort"){
    if(!scheduleCohortGroup){ alert("No regular-student cohort is selected or available — set a Target Semester and optimize again."); return; }
    const { group, blockIndex } = parseCohortComposite(scheduleCohortGroup);
    const blocksUsed = state.schedule ? (state.schedule.blocksUsed || 1) : 1;
    const blockSuffix = blocksUsed>=2 ? ` (Block ${blockIndex+1})` : "";
    assignments = assignments.filter(a=> a.cohortGroup===group && (a.blockIndex||0)===blockIndex);
    filename = `schedule-cohort-${slugify(cohortGroupLabel(group)+blockSuffix)}.csv`;
    scopeLabel = cohortGroupLabel(group) + blockSuffix;
  }

  if(assignments.length===0){ alert(`No scheduled sessions to export for ${scopeLabel || "this view"} yet.`); return; }

  const rows = [["Subject","Faculty","Room","Day","Start","End"]];
  assignments.slice()
    .sort((a,b)=> DAYS.indexOf(a.day)-DAYS.indexOf(b.day) || a.startSlot-b.startSlot)
    .forEach(a=> rows.push([a.subjectName, a.facultyName || "", a.roomName, DAY_FULL[a.day], fmtTime(a.startMin), fmtTime(a.endMin)]));
  const csv = rows.map(r=> r.map(v=> `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------
   EVENT WIRING
--------------------------------------------------------------------- */
document.querySelectorAll(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c=>c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-"+btn.dataset.tab).classList.add("active");
    trackEvent("switchTab", { eventType:"navigation", extra:{ tab: btn.dataset.tab } });
    if(btn.dataset.tab === "usage") renderUsageSummary();
  });
});

// Guide tab flowchart: click (or Enter/Space) a step card to jump straight to that tab.
function jumpToTabFromGuide(tab){
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if(btn) btn.click();
}
document.querySelectorAll(".flow-step[data-jump]").forEach(el=>{
  el.addEventListener("click", ()=> jumpToTabFromGuide(el.dataset.jump));
  el.addEventListener("keydown", (e)=>{
    if(e.key==="Enter" || e.key===" "){ e.preventDefault(); jumpToTabFromGuide(el.dataset.jump); }
  });
});

document.getElementById("add-room-btn").addEventListener("click", ()=>{
  const nameInput = document.getElementById("room-name");
  const capInput = document.getElementById("room-capacity");
  const openFromSel = document.getElementById("room-open-from");
  const openUntilSel = document.getElementById("room-open-until");
  const usagePctInput = document.getElementById("room-usage-percent");
  const name = nameInput.value.trim();
  if(!name){ alert("Please enter a room name."); nameInput.focus(); return; }
  let cap = null;
  if(capInput.value.trim()){
    cap = parseInt(capInput.value,10);
    if(isNaN(cap) || cap<=0){ alert("Capacity must be a positive whole number, or left blank."); capInput.focus(); return; }
  }
  const openMin = parseInt(openFromSel.value, 10);
  const closeMin = parseInt(openUntilSel.value, 10);
  if(closeMin <= openMin){ alert('"Open Until" must be after "Open From".'); return; }
  let usagePct = 100;
  if(usagePctInput.value.trim()){
    usagePct = parseInt(usagePctInput.value,10);
    if(isNaN(usagePct) || usagePct<1 || usagePct>100){ alert("Allowable Usage % must be a whole number from 1 to 100."); usagePctInput.focus(); return; }
  }
  const roomType = document.getElementById("room-type").value;
  addRoom(name, cap, openMin, closeMin, usagePct, roomType);
  nameInput.value=""; capInput.value=""; usagePctInput.value="100";
  document.getElementById("room-type").value = "BOTH";
  nameInput.focus();
});

document.getElementById("room-list").addEventListener("click",(e)=>{
  const editBtn = e.target.closest('[data-action="edit-avail"]');
  const delBtn = e.target.closest('[data-action="delete-room"]');
  if(editBtn) openAvailModal(editBtn.dataset.id);
  if(delBtn) deleteRoom(delBtn.dataset.id);
});

const SPLIT_ELIGIBLE_SLOTS = "6"; // 6 x 30min = 3 hours

const typeSelectEl = document.getElementById("subj-type");
const durationSelectEl = document.getElementById("subj-duration");
const splitToggleField = document.getElementById("split-toggle-field");
const splitToggleEl = document.getElementById("subj-split-toggle");
const splitPairField = document.getElementById("split-pair-field");
const labSplitToggleField = document.getElementById("lab-split-toggle-field");
const labSplitToggleEl = document.getElementById("subj-lab-split-toggle");
const sessionsInputEl = document.getElementById("subj-sessions");

function refreshSplitUI(){
  const isLab = typeSelectEl.value === "LAB";

  // Lecture-only: 3-hour paired time-split (2x1.5h on Mon+Wed / Tue+Thu / Fri+Sat).
  const eligible = !isLab && durationSelectEl.value === SPLIT_ELIGIBLE_SLOTS;
  splitToggleField.style.display = eligible ? "" : "none";
  if(!eligible && splitToggleEl.checked){
    splitToggleEl.checked = false;
  }
  const splitOn = eligible && splitToggleEl.checked;
  splitPairField.style.display = splitOn ? "" : "none";

  // Laboratory-only: capacity split into 2 identical full-length independent sections.
  labSplitToggleField.style.display = isLab ? "" : "none";
  if(!isLab && labSplitToggleEl.checked){
    labSplitToggleEl.checked = false;
  }
  const labSplitOn = isLab && labSplitToggleEl.checked;

  sessionsInputEl.disabled = splitOn || labSplitOn;
  if(splitOn || labSplitOn){
    sessionsInputEl.value = "2";
  }
}
typeSelectEl.addEventListener("change", refreshSplitUI);
durationSelectEl.addEventListener("change", refreshSplitUI);
splitToggleEl.addEventListener("change", refreshSplitUI);
labSplitToggleEl.addEventListener("change", refreshSplitUI);

document.getElementById("add-subject-btn").addEventListener("click", ()=>{
  const nameInput = document.getElementById("subj-name");
  const name = nameInput.value.trim();
  if(!name){ alert("Please enter a subject code."); nameInput.focus(); return; }

  const type = typeSelectEl.value === "LAB" ? "LAB" : "LEC";
  const isSplit = type === "LEC" && durationSelectEl.value === SPLIT_ELIGIBLE_SLOTS && splitToggleEl.checked;
  const isCapacitySplit = type === "LAB" && labSplitToggleEl.checked;
  const durationSlots = isSplit ? 3 : parseInt(durationSelectEl.value,10); // 3 slots = 1.5h per split session
  const dayPairPref = isSplit ? document.getElementById("subj-split-pair").value : null;

  let sessions = parseInt(sessionsInputEl.value,10) || 1;
  sessions = (isSplit || isCapacitySplit) ? 2 : Math.max(1, Math.min(7, sessions));

  const sizeInput = document.getElementById("subj-size");
  let size = null;
  if(sizeInput.value.trim()){
    size = parseInt(sizeInput.value,10);
    if(isNaN(size) || size<=0){ alert("Class size must be a positive whole number, or left blank."); sizeInput.focus(); return; }
  }
  const prospectusSelect = document.getElementById("subj-prospectus-course");
  const prospectusCourseId = prospectusSelect.value || null;
  const externalToggleEl = document.getElementById("subj-external-toggle");
  const externalAssignment = externalToggleEl.checked;
  const levelSelect = document.getElementById("subj-level");
  const level = levelSelect && levelSelect.value==="GRAD" ? "GRAD" : "UG";

  addSubject(name, durationSlots, sessions, size, isSplit, dayPairPref, type, isCapacitySplit, prospectusCourseId, externalAssignment, level);

  nameInput.value=""; sizeInput.value="";
  splitToggleEl.checked = false;
  labSplitToggleEl.checked = false;
  sessionsInputEl.disabled = false;
  sessionsInputEl.value = "1";
  prospectusSelect.value = "";
  externalToggleEl.checked = false;
  if(levelSelect) levelSelect.value = "UG";
  refreshSplitUI();
  nameInput.focus();
});

document.getElementById("subject-list").addEventListener("click",(e)=>{
  const delBtn = e.target.closest('[data-action="delete-subject"]');
  const extBtn = e.target.closest('[data-action="toggle-external"]');
  if(delBtn) deleteSubject(delBtn.dataset.id);
  if(extBtn) toggleSubjectExternal(extBtn.dataset.id);
});

document.getElementById("add-faculty-btn").addEventListener("click", ()=>{
  const nameInput = document.getElementById("faculty-name");
  const name = nameInput.value.trim();
  if(!name){ alert("Please enter a faculty name."); nameInput.focus(); return; }
  const adminUnitsInput = document.getElementById("faculty-admin-units");
  let adminResearchUnits = 0;
  if(adminUnitsInput && adminUnitsInput.value.trim()){
    adminResearchUnits = parseFloat(adminUnitsInput.value);
    if(isNaN(adminResearchUnits) || adminResearchUnits<0){ alert("Admin/Research Load Units must be zero or a positive number."); adminUnitsInput.focus(); return; }
  }
  const subjectsSelect = document.getElementById("faculty-subjects");
  const subjectIds = Array.from(subjectsSelect.selectedOptions).map(o=>o.value);
  addFaculty(name, subjectIds, adminResearchUnits);
  nameInput.value = "";
  if(adminUnitsInput) adminUnitsInput.value = "0";
  Array.from(subjectsSelect.options).forEach(o=> o.selected = false);
  nameInput.focus();
});

document.getElementById("faculty-list-select").addEventListener("change", renderFacultyDetail);
document.getElementById("delete-faculty-btn").addEventListener("click", ()=>{
  const sel = document.getElementById("faculty-list-select");
  if(sel.value) deleteFaculty(sel.value);
});

/* --- Prospectus tab wiring --- */
document.getElementById("prospectus-list").addEventListener("click",(e)=>{
  const delBtn = e.target.closest('[data-action="delete-prospectus-course"]');
  const delProgramBtn = e.target.closest('[data-action="delete-prospectus-program"]');
  if(delBtn) deleteProspectusCourse(delBtn.dataset.id);
  if(delProgramBtn) deleteProspectusProgram(delProgramBtn.dataset.program);
});
document.getElementById("prospectus-clear-btn").addEventListener("click", clearProspectus);

document.getElementById("prospectus-export-btn").addEventListener("click", exportProspectusCsv);
document.getElementById("prospectus-template-btn").addEventListener("click", downloadProspectusTemplate);
document.getElementById("prospectus-import-btn").addEventListener("click", ()=> document.getElementById("prospectus-import-file").click());
document.getElementById("prospectus-import-file").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  const programInput = document.getElementById("prospectus-program-input");
  const defaultProgram = programInput ? programInput.value.trim() : "";
  if(file) handleCsvImport(file, (rows)=> importProspectusFromRows(rows, defaultProgram), (r)=>
    `Imported ${r.added} prospectus course(s).${r.duplicates ? ` Skipped ${r.duplicates} duplicate(s) already in your prospectus.` : ""}${r.skipped ? ` Skipped ${r.skipped} row(s) missing Program/Year/Term/Code/Title.` : ""}`
  , ["program", "year"]);
  e.target.value = "";
});

document.getElementById("prospectus-pdf-btn").addEventListener("click", ()=> document.getElementById("prospectus-pdf-file").click());
document.getElementById("prospectus-pdf-file").addEventListener("change", async (e)=>{
  const file = e.target.files[0];
  e.target.value = "";
  if(!file) return;
  if(!/\.pdf$/i.test(file.name)){
    alert(`"${file.name}" doesn't look like a PDF file (expected a .pdf extension) — pick the right file, or use CSV import instead.`);
    return;
  }
  // PDF rows never carry a Program column (the parser can't reliably read a curriculum's
  // cover-page title), so a Program Name is required up front — every parsed course gets
  // tagged with it, which is also what lets duplicate-detection tell two programs' courses
  // apart even when they happen to share a course code (e.g. NSTP, PE).
  const programInput = document.getElementById("prospectus-program-input");
  const program = programInput ? programInput.value.trim() : "";
  if(!program){
    alert('Enter a "Program Name" first (e.g. "BS Electrical Engineering") — every course in this PDF will be tagged with it.');
    programInput && programInput.focus();
    return;
  }
  if(typeof window.parseProspectusPdf !== "function"){
    alert("The PDF-parsing module didn't load. Try refreshing the page, or use CSV import instead.");
    return;
  }
  const statusEl = document.getElementById("prospectus-pdf-status");
  statusEl.textContent = "Reading PDF… (loads a PDF-parsing library from the internet the first time)";
  try{
    const parsed = await window.parseProspectusPdf(file);
    statusEl.textContent = "";
    if(parsed.length===0){
      alert('Couldn\'t find any recognizable "Year, Term" course table in that PDF. Try CSV import instead, or check the file.');
      return;
    }
    openProspectusReviewModal(parsed, program);
    trackEvent("uploadProspectusPdf", { extra:{ parsedCourseCount: parsed.length } });
  }catch(err){
    statusEl.textContent = "";
    const msg = err && err.message ? err.message : String(err);
    alert("Couldn't read that PDF: " + msg);
    trackEvent("uploadProspectusPdf", { eventType:"error", errorMessage: msg });
  }
});

document.getElementById("prospectus-review-table").addEventListener("input",(e)=>{
  const i = e.target.dataset.i, f = e.target.dataset.f;
  if(i==null || !f) return;
  const v = e.target.value;
  prospectusReviewRows[i][f] = (f==="units"||f==="lec"||f==="lab") ? (v===""?null:Number(v)) : v;
  if(f==="program"||f==="yearLabel"||f==="term"||f==="code") renderProspectusReviewTable(); // re-flag duplicates live
});
document.getElementById("prospectus-review-table").addEventListener("click",(e)=>{
  const btn = e.target.closest("[data-remove]");
  if(!btn) return;
  prospectusReviewRows.splice(Number(btn.dataset.remove),1);
  renderProspectusReviewTable();
});
document.getElementById("prospectus-review-cancel").addEventListener("click", closeProspectusReviewModal);
document.getElementById("prospectus-review-modal-backdrop").addEventListener("click",(e)=>{
  if(e.target.id === "prospectus-review-modal-backdrop") closeProspectusReviewModal();
});
document.getElementById("prospectus-review-import").addEventListener("click", ()=>{
  let added = 0, skipped = 0, duplicates = 0;
  const seen = new Set(state.prospectus.map(c=> prospectusDupKey(c.program, c.yearLabel, c.term, c.code)));
  prospectusReviewRows.forEach(c=>{
    if(!c.program || !c.code || !c.title || !c.yearLabel || !c.term){ skipped++; return; }
    const term = normalizeTermValue(c.term);
    const key = prospectusDupKey(c.program, c.yearLabel, term, c.code);
    if(seen.has(key)){ duplicates++; return; }
    seen.add(key);
    state.prospectus.push({
      id: genId("psc"),
      program: c.program,
      year: YEAR_LABEL_TO_NUM[c.yearLabel] || null,
      yearLabel: c.yearLabel, term, code: c.code, title: c.title,
      units: c.units, lec: c.lec||0, lab: c.lab||0
    });
    added++;
  });
  saveState();
  renderProspectus();
  closeProspectusReviewModal();
  alert(`Imported ${added} course(s).${duplicates ? ` Skipped ${duplicates} duplicate(s) already in your prospectus.` : ""}${skipped ? ` Skipped ${skipped} row(s) still missing required fields.` : ""}`);
  trackEvent("importProspectusPdfReview", { extra:{ added, skipped, duplicates } });
});

function updateTargetTermHint(){
  const hint = document.getElementById("target-term-hint");
  if(!hint) return;
  if(!state.targetTerm){ hint.textContent = ""; return; }
  const programCount = distinctPrograms().length;
  hint.textContent = `Loads every uploaded program's "${state.targetTerm}" courses${programCount>1 ? ` (${programCount} programs)` : ""}. Each program's own year level is checked separately — different programs (or different year levels) never block each other.`;
}

document.getElementById("target-term-select").addEventListener("change",(e)=>{
  const previousTerm = state.targetTerm;
  const newTerm = e.target.value;

  // Switching to a different, real term wipes the ENTIRE Subjects tab first, then loads the
  // newly-selected term fresh — so it always starts from a clean slate instead of mixing in
  // whatever was listed before. That's destructive (and removes faculty's subject links too),
  // so confirm first; cancelling reverts the dropdown back to what it was. Selecting
  // "— none —" just turns the conflict check off and leaves the current subject list alone.
  if(newTerm && newTerm !== previousTerm && state.subjects.length>0){
    const proceed = confirm(`Switching Target Semester clears ALL ${state.subjects.length} subject(s) currently in the Subjects tab before loading "${newTerm}". This cannot be undone. Continue?`);
    if(!proceed){
      e.target.value = previousTerm; // revert the dropdown, nothing changed
      return;
    }
  }

  state.targetTerm = newTerm;
  saveState();
  updateTargetTermHint();

  if(newTerm && newTerm !== previousTerm){
    if(state.prospectus.length===0){
      alert(`No prospectus uploaded yet — go to the Prospectus tab and import a CSV or PDF first, then pick a Target Semester here to load its subjects.`);
      return;
    }
    const removedCount = clearAllSubjects();
    const result = autoPopulateSubjectsForTerm(newTerm);
    if(removedCount>0 || result.added>0 || result.skipped>0){
      saveState();
      renderSubjects();
      renderFaculty();
      renderScheduleTab();
      const parts = [];
      if(removedCount>0) parts.push(`Cleared ${removedCount} subject(s) from the Subjects tab.`);
      parts.push(`Loaded ${result.added} subject(s) for ${newTerm}.`);
      if(result.skipped) parts.push(`${result.skipped} course(s) skipped (already linked to a subject, or had no weekly Lec/Lab hours).`);
      // Never leave "Loaded 0" unexplained — say plainly why, instead of leaving the user to guess.
      if(result.added===0 && result.matched===0) parts.push(`No prospectus courses found with Term "${newTerm}" — check the Prospectus tab; Term values must read exactly "First Semester", "Second Semester", or "Summer Term".`);
      alert(parts.join(" ") + `\n\nReview durations/sessions in the Subjects tab — defaults are a best guess from the prospectus's weekly hours.`);
    } else {
      // Never fail silently: this is the case that looks like "nothing happened" — the
      // prospectus has data, but none of it has a Term that reads exactly "<newTerm>".
      alert(`No prospectus courses found with Term "${newTerm}". Check the Prospectus tab — your uploaded Term values must read exactly "First Semester", "Second Semester", or "Summer Term" (re-download the CSV template if you're using an older file, since it now also needs a Program column).`);
    }
    trackEvent("changeTargetSemester", { extra:{ term: newTerm, loaded: result.added, cleared: removedCount } });
  }
});

document.getElementById("global-blocks-input").addEventListener("change",(e)=>{
  let v = parseInt(e.target.value,10);
  if(isNaN(v) || v<1) v = 1;
  e.target.value = v;
  state.blocks = v;
  saveState();
});

/* ---------------------------------------------------------------------
   GA PROGRESS / CONVERGENCE MODAL
--------------------------------------------------------------------- */
let gaFitnessHistory = [];
let gaGapHistory = [];

function openGaModal(){
  gaFitnessHistory = [];
  gaGapHistory = [];
  document.getElementById("ga-modal-title").innerHTML = '<span class="ga-spinner" id="ga-spinner"></span>Optimizing Schedule…';
  document.getElementById("ga-modal-close").style.display = "none";
  document.getElementById("ga-progress-fill").style.width = "0%";
  document.getElementById("ga-progress-pct").textContent = "0%";
  document.getElementById("ga-progress-hint").textContent = "Starting…";
  ["ga-stat-gen","ga-stat-pop","ga-stat-scheduled","ga-stat-gap","ga-stat-latelab","ga-stat-friday","ga-stat-nobreak","ga-stat-facgap","ga-stat-cohorts"].forEach(id=>{
    document.getElementById(id).textContent = "–";
  });
  document.getElementById("ga-stat-cohorts-tile").style.display = "none";
  drawGaCharts();
  document.getElementById("ga-modal-backdrop").classList.add("open");
}
function closeGaModal(){
  document.getElementById("ga-modal-backdrop").classList.remove("open");
}

function svgPolylinePoints(values, w, h, pad){
  if(values.length===0) return "";
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = (hi - lo) || 1;
  const n = values.length;
  return values.map((v,i)=>{
    const x = n===1 ? pad : pad + (i/(n-1)) * (w - pad*2);
    const y = h - pad - ((v - lo) / span) * (h - pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}
function setChartYAxis(elId, values){
  const el = document.getElementById(elId);
  if(values.length < 2){ el.innerHTML = ""; return; }
  const hi = Math.max(...values), lo = Math.min(...values);
  el.innerHTML = `<span>${Math.round(hi).toLocaleString()}</span><span>${Math.round(lo).toLocaleString()}</span>`;
}

function drawGaCharts(){
  const fEl = document.getElementById("ga-chart-fitness");
  const gEl = document.getElementById("ga-chart-gap");
  const fw = 600, fh = 120, gw = 600, gh = 90, pad = 8;

  if(gaFitnessHistory.length < 2){
    fEl.innerHTML = "";
    gEl.innerHTML = "";
    document.getElementById("ga-chart-fitness-yaxis").innerHTML = "";
    document.getElementById("ga-chart-gap-yaxis").innerHTML = "";
    return;
  }
  const fPts = svgPolylinePoints(gaFitnessHistory, fw, fh, pad);
  const fAreaPts = `${pad},${fh-pad} ${fPts} ${fw-pad},${fh-pad}`;
  fEl.innerHTML = `<polyline class="fillarea" points="${fAreaPts}"></polyline><polyline class="line" points="${fPts}"></polyline>`;
  setChartYAxis("ga-chart-fitness-yaxis", gaFitnessHistory);

  const gPts = svgPolylinePoints(gaGapHistory, gw, gh, pad);
  gEl.innerHTML = `<polyline class="line gapline" points="${gPts}"></polyline>`;
  setChartYAxis("ga-chart-gap-yaxis", gaGapHistory);
}

// How many trailing generations have shown zero fitness improvement — used to tell the
// user when the search has effectively converged rather than leaving them guessing.
function plateauStreak(history){
  if(history.length===0) return 0;
  const last = history[history.length-1];
  let streak = 0;
  for(let i=history.length-1; i>=0 && history[i]===last; i--) streak++;
  return streak - 1;
}

function updateGaModal(progress){
  document.getElementById("ga-stat-gen").textContent = `${progress.generation} / ${progress.maxGenerations}`;
  document.getElementById("ga-stat-pop").textContent = progress.popSize;
  document.getElementById("ga-stat-scheduled").textContent = `${progress.scheduledCount} / ${progress.totalSessions}`;
  document.getElementById("ga-stat-gap").textContent = progress.gapScore;
  document.getElementById("ga-stat-latelab").textContent = progress.lateLabCount;
  document.getElementById("ga-stat-friday").textContent = progress.fridayCount;
  document.getElementById("ga-stat-nobreak").textContent = progress.facultyNoBreakCount;
  document.getElementById("ga-stat-facgap").textContent = progress.facultyGapScore;
  // Only shown when a Target Semester is actually loading regular-student cohorts — each
  // group is one independent program+year-level (e.g. a 4-year program's term has 4 of
  // these), all being satisfied at once by this same run.
  const cohortTile = document.getElementById("ga-stat-cohorts-tile");
  if(progress.cohortGroups>0){
    cohortTile.style.display = "";
    document.getElementById("ga-stat-cohorts").textContent = `${progress.cohortGroups} (${progress.studentConflicts} unresolved)`;
  } else {
    cohortTile.style.display = "none";
  }

  gaFitnessHistory.push(progress.fitness);
  gaGapHistory.push(progress.gapScore);
  drawGaCharts();

  const pct = clamp(Math.round(100 * progress.generation / progress.maxGenerations), 0, 100);
  document.getElementById("ga-progress-fill").style.width = pct + "%";
  document.getElementById("ga-progress-pct").textContent = pct + "%";

  const hintEl = document.getElementById("ga-progress-hint");
  const plateau = plateauStreak(gaFitnessHistory);
  if(progress.done){
    hintEl.textContent = `Converged after ${progress.generation} generation(s).`;
  } else if(plateau >= 5){
    hintEl.textContent = `No improvement in the last ${plateau} generations — likely near-optimal, still refining room utilization…`;
  } else {
    hintEl.textContent = `Searching for a better arrangement… (${progress.scheduledCount}/${progress.totalSessions} sessions placed so far)`;
  }

  if(progress.done){
    document.getElementById("ga-progress-fill").style.width = "100%";
    document.getElementById("ga-progress-pct").textContent = "100%";
    document.getElementById("ga-modal-title").textContent = "✅ Optimization Complete";
    document.getElementById("ga-modal-close").style.display = "";
  }
}

document.getElementById("ga-modal-close").addEventListener("click", closeGaModal);

document.getElementById("optimize-btn").addEventListener("click", async ()=>{
  if(state.subjects.length===0){ alert("Add at least one subject first."); return; }
  // A room is only required if at least one subject actually needs one — an all-External-
  // Assignment subject list (every session's room/faculty handled elsewhere) is a valid
  // scenario the optimizer can run with zero rooms defined.
  const needsRoom = state.subjects.some(s=>!s.externalAssignment);
  if(needsRoom && state.rooms.length===0){ alert("Add at least one room first (or mark every subject as External Assignment if none of them need one)."); return; }
  // Sync Number of Blocks in case it was typed but never blurred/changed-out-of.
  const blocksInput = document.getElementById("global-blocks-input");
  let blocksVal = parseInt(blocksInput.value,10);
  if(isNaN(blocksVal) || blocksVal<1) blocksVal = 1;
  blocksInput.value = blocksVal;
  state.blocks = blocksVal;
  saveState();
  const btn = document.getElementById("optimize-btn");
  const status = document.getElementById("optimize-status");
  btn.disabled = true; btn.textContent = "Optimizing…";
  status.textContent = "";
  openGaModal();

  // Let the modal actually paint before the (mostly synchronous, per-generation) GA work begins.
  await nextTick();

  let result = await optimizeSchedule(updateGaModal);

  btn.disabled = false; btn.textContent = "⚡ Optimize Scheduling";
  if(!result){
    closeGaModal();
    status.textContent = "Nothing to schedule.";
    trackEvent("optimize", { eventType:"optimize_complete", numRooms: state.rooms.length, extra:{ result:"nothing_to_schedule" } });
    return;
  }
  result = validateAndSplitConflicts(result);
  state.schedule = result;
  saveState();
  const total = result.assignments.length + result.unscheduled.length;
  const genInfo = `(GA: ${result.generationsRun} gen × ${result.populationSize} pop)`;
  status.textContent = result.unscheduled.length===0
    ? `✅ All ${total} sessions scheduled. ${genInfo}`
    : `⚠ ${result.assignments.length}/${total} sessions scheduled. ${genInfo}`;
  renderScheduleTab();
  trackEvent("optimize", {
    eventType: "optimize_complete",
    generations: result.generationsRun,
    populationSize: result.populationSize,
    numRooms: state.rooms.length,
    extra: { scheduledCount: result.assignments.length, unscheduledCount: result.unscheduled.length, totalSessions: total, numSubjects: state.subjects.length, numFaculty: state.faculty.length }
  });
});

document.getElementById("clear-schedule-btn").addEventListener("click", ()=>{
  if(!state.schedule) return;
  if(!confirm("Clear the current schedule result?")) return;
  state.schedule = null;
  saveState();
  document.getElementById("optimize-status").textContent = "";
  renderScheduleTab();
});

/* ---------------------------------------------------------------------
   APP USAGE SUMMARY (reads back what server.py has logged to usage_log.csv)
--------------------------------------------------------------------- */
// Generic hand-rolled SVG bar chart — same house style as the GA convergence charts
// (no external chart library), used for any single-series categorical breakdown.
function svgBarChart(labels, values, opts){
  opts = opts || {};
  const w = opts.width || 640, h = opts.height || 220;
  const padTop = 22, padBottom = 34, padSide = 10;
  const n = values.length;
  if(n===0) return "";
  const max = Math.max(1, ...values);
  const gap = 8;
  const barW = Math.max(6, (w - padSide*2) / n - gap);
  let svg = "";
  values.forEach((v,i)=>{
    const x = padSide + i*((w - padSide*2)/n);
    const barH = ((h - padTop - padBottom) * v) / max;
    const y = h - padBottom - barH;
    const label = String(labels[i]==null ? "" : labels[i]);
    const shortLabel = label.length>14 ? label.slice(0,13)+"…" : label;
    svg += `<rect class="bar-rect" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0,barH).toFixed(1)}" rx="3"><title>${escapeHtml(label)}: ${v}</title></rect>`;
    svg += `<text class="bar-value" x="${(x+barW/2).toFixed(1)}" y="${(y-5).toFixed(1)}" text-anchor="middle">${v}</text>`;
    svg += `<text class="bar-label" x="${(x+barW/2).toFixed(1)}" y="${h-padBottom+13}" text-anchor="middle">${escapeHtml(shortLabel)}<title>${escapeHtml(label)}</title></text>`;
  });
  return `<svg class="usage-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${svg}</svg>`;
}
// Line chart for a value sampled over time (reuses the same point-plotting math as the GA
// convergence charts, just standalone here since the summary tab renders independently of
// an optimize run).
function svgLineChart(values, opts){
  opts = opts || {};
  const w = opts.width || 640, h = opts.height || 160, pad = 12;
  if(values.length===0) return "";
  const pts = svgPolylinePoints(values, w, h, pad);
  const areaPts = `${pad},${h-pad} ${pts} ${w-pad},${h-pad}`;
  return `<svg class="usage-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline class="fillarea" points="${areaPts}"></polyline>
    <polyline class="line" points="${pts}"></polyline>
  </svg>`;
}
function usageStatTile(label, value){
  return `<div class="summary-item"><div class="label">${escapeHtml(label)}</div><b>${value}</b></div>`;
}

async function renderUsageSummary(){
  const container = document.getElementById("usage-summary-results");
  if(!container) return;
  container.innerHTML = '<div class="panel"><div class="empty">Loading usage data…</div></div>';

  let events;
  try{
    const res = await fetch("/api/usage-data", { cache: "no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    events = Array.isArray(data.events) ? data.events : [];
  }catch(e){
    container.innerHTML = `<div class="panel"><div class="usage-empty-note">
      <b>No usage-tracking server detected.</b> This tab reads live data from a <code>/api/usage-data</code>
      endpoint that only exists when the app is served by <code>server.py</code>, not the plain
      <code>python3 -m http.server</code>. From the project folder, run:
      <br><br><code>python3 server.py</code>
      <br><br>then reload this page and come back to this tab. Everything else in the app works
      exactly the same either way — tracking is optional and never required for scheduling.
    </div></div>`;
    return;
  }

  if(events.length===0){
    container.innerHTML = `<div class="panel"><div class="empty">No usage recorded yet — activity will appear here as the app is used (yours included). Try adding a room or running Optimize, then click Refresh above.</div></div>`;
    return;
  }

  // --- Aggregate everything client-side from the raw event list ---
  const uniqueSessions = new Set(events.map(e=>e.session_id).filter(Boolean));
  const uniqueIps = new Set(events.map(e=>e.ip).filter(Boolean));
  const functionCounts = {};
  events.forEach(e=>{ if(e.function_name){ functionCounts[e.function_name] = (functionCounts[e.function_name]||0)+1; } });
  const funcEntries = Object.entries(functionCounts).sort((a,b)=>b[1]-a[1]);

  const latencySamples = events.map(e=>parseFloat(e.latency_ms)).filter(v=>!isNaN(v) && v>=0);
  const avgLatency = latencySamples.length ? (latencySamples.reduce((a,b)=>a+b,0)/latencySamples.length) : null;
  const maxLatency = latencySamples.length ? Math.max(...latencySamples) : null;
  const minLatency = latencySamples.length ? Math.min(...latencySamples) : null;

  const optimizeRuns = events.filter(e=>e.event_type==="optimize_complete" && e.function_name==="optimize")
    .sort((a,b)=> (a.timestamp||"").localeCompare(b.timestamp||""));
  const errors = events.filter(e=>e.event_type==="error")
    .sort((a,b)=> (b.timestamp||"").localeCompare(a.timestamp||""));

  const recent = events.slice().sort((a,b)=> (b.timestamp||"").localeCompare(a.timestamp||"")).slice(0,50);

  let html = "";

  // Shown only when printed (the on-screen title lives in the .no-print toolbar panel above,
  // which is hidden on the printed page) — so a printed copy is self-explanatory on its own.
  html += `<div class="print-only">
    <h1 style="margin:0 0 4px;font-size:19px;">App Usage Summary — Room Scheduling Optimization System</h1>
    <p style="margin:0 0 14px;color:#555;font-size:12px;">Printed ${escapeHtml(new Date().toLocaleString())} &nbsp;•&nbsp; ${events.length} event(s) recorded &nbsp;•&nbsp; ${uniqueSessions.size} visitor session(s)</p>
  </div>`;

  // --- Overview stat tiles ---
  html += `<div class="summary-bar">
    ${usageStatTile("Visitor Count (sessions)", uniqueSessions.size)}
    ${usageStatTile("Unique IP Addresses", uniqueIps.size)}
    ${usageStatTile("Total Events Recorded", events.length)}
    ${usageStatTile("Distinct Functions Used", funcEntries.length)}
    ${usageStatTile("Optimizer Runs", optimizeRuns.length)}
    ${usageStatTile("Errors Reported", errors.length)}
  </div>`;

  // --- Function usage bar chart ---
  html += `<div class="panel">
    <h2>Function Usage</h2>
    <div class="usage-chart-wrap">${svgBarChart(funcEntries.slice(0,12).map(x=>x[0]), funcEntries.slice(0,12).map(x=>x[1]))}</div>
    <p class="usage-chart-caption">How many times each app action has been used (top ${Math.min(12,funcEntries.length)} of ${funcEntries.length}), across every visitor recorded — taller bars mean that feature gets used more, which is a good signal for where to focus testing or polish.</p>
  </div>`;

  // --- Latency line chart ---
  if(latencySamples.length>=2){
    html += `<div class="panel">
      <h2>Network Latency</h2>
      <div class="summary-bar">
        ${usageStatTile("Average", avgLatency.toFixed(0)+" ms")}
        ${usageStatTile("Fastest", minLatency.toFixed(0)+" ms")}
        ${usageStatTile("Slowest", maxLatency.toFixed(0)+" ms")}
      </div>
      <div class="usage-chart-wrap">${svgLineChart(latencySamples)}</div>
      <p class="usage-chart-caption">Round-trip time (in milliseconds) of each recorded tracking request, in the order they happened — a rough proxy for how responsive the connection to the server has been. Spikes suggest network congestion or server load rather than anything wrong with the scheduling logic itself, which runs entirely in the browser.</p>
    </div>`;
  }

  // --- Optimizer runs: population size chart + detail table ---
  if(optimizeRuns.length>0){
    const popValues = optimizeRuns.map(e=> parseInt(e.population_size,10) || 0);
    const runLabels = optimizeRuns.map((e,i)=> "Run "+(i+1));
    html += `<div class="panel">
      <h2>Optimizer Runs — Generations &amp; Population</h2>
      <div class="usage-chart-wrap">${svgBarChart(runLabels.slice(-12), popValues.slice(-12))}</div>
      <p class="usage-chart-caption">Population size the genetic algorithm auto-scaled to for each of the last ${Math.min(12,optimizeRuns.length)} optimize run(s) (of ${optimizeRuns.length} total) — larger populations mean a harder scheduling problem (more rooms/subjects/constraints) was being solved.</p>
      <div style="overflow-x:auto;margin-top:12px;">
        <table class="list-table">
          <thead><tr><th>When</th><th>Generations</th><th>Population</th><th>Rooms</th><th>Scheduled</th></tr></thead>
          <tbody>${optimizeRuns.slice().reverse().slice(0,20).map(e=>{
            const extra = (function(){ try{ return JSON.parse(e.details||"{}"); }catch(err){ return {}; } })();
            return `<tr>
              <td>${escapeHtml(e.timestamp||"")}</td>
              <td>${escapeHtml(e.generations||"")}</td>
              <td>${escapeHtml(e.population_size||"")}</td>
              <td>${escapeHtml(e.num_rooms||"")}</td>
              <td>${extra.scheduledCount!=null ? `${extra.scheduledCount}/${extra.totalSessions}` : ""}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    </div>`;
  }

  // --- Errors table ---
  if(errors.length>0){
    html += `<div class="panel conflict-panel">
      <h2>⚠️ Error Reports (${errors.length})</h2>
      <p class="usage-chart-caption">Uncaught JavaScript errors and promise rejections captured automatically from every visitor's browser — useful for spotting bugs that don't show up in normal testing.</p>
      <div style="overflow-x:auto;">
        <table class="list-table">
          <thead><tr><th>When</th><th>Where</th><th>Message</th></tr></thead>
          <tbody>${errors.slice(0,30).map(e=>`<tr>
            <td>${escapeHtml(e.timestamp||"")}</td>
            <td>${escapeHtml(e.function_name||"")}</td>
            <td>${escapeHtml(e.error_message||"")}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>`;
  }

  // --- Recent activity table ---
  html += `<div class="panel">
    <h2>Recent Activity</h2>
    <p class="usage-chart-caption">The most recent ${recent.length} recorded events across all visitors, newest first — a raw activity feed for spot-checking what's actually happening in the app.</p>
    <div style="overflow-x:auto;">
      <table class="list-table">
        <thead><tr><th>When</th><th>IP</th><th>Function</th><th>Type</th></tr></thead>
        <tbody>${recent.map(e=>`<tr>
          <td>${escapeHtml(e.timestamp||"")}</td>
          <td>${escapeHtml(e.ip||"")}</td>
          <td>${escapeHtml(e.function_name||"")}</td>
          <td>${escapeHtml(e.event_type||"")}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>
  </div>`;

  container.innerHTML = html;
}

document.getElementById("usage-refresh-btn").addEventListener("click", renderUsageSummary);
document.getElementById("usage-print-btn").addEventListener("click", ()=>{
  window.print();
  trackEvent("printUsageSummary");
});

/* ---------------------------------------------------------------------
   IMPORT / EXPORT (CSV — opens and edits directly in Excel)
--------------------------------------------------------------------- */
function parseCsv(text){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const len = text.length;
  for(let i=0;i<len;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if(c === '"'){ inQuotes = true; }
    else if(c === ','){ row.push(field); field = ""; }
    else if(c === '\r'){ /* skip */ }
    else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if(field.length>0 || row.length>0){ row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length===1 && r[0].trim()===""));
}
function rowsToCsv(rows){
  return rows.map(r => r.map(v => `"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
}
function downloadCsv(filename, rows){
  const blob = new Blob([rowsToCsv(rows)], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
// Reads a CSV File, strips a recognizable header row if present, and hands the remaining
// data rows to `importFn`; shows the result via `alert` using `summaryFn`. `firstColHint`
// (lowercase) is the expected header text of column 1 for this import type — e.g. "name" for
// Rooms/Subjects/Faculty, "program" for Prospectus — checked precisely (rather than a blanket
// "does this row contain the word 'name' anywhere") so a real data row that happens to start
// with a similar-looking word is never mistaken for the header and silently dropped, and a
// header row that DOESN'T contain that hint is never mistaken for data and imported as garbage.
function handleCsvImport(file, importFn, summaryFn, firstColHint){
  if(!/\.csv$/i.test(file.name)){
    alert(`"${file.name}" doesn't look like a CSV file (expected a .csv extension) — pick the right file, or use "Download Template" for the exact format.`);
    return;
  }
  // Accepts either one hint or a list of acceptable ones (e.g. Prospectus recognizes both its
  // current "Program"-first header AND an older "Year"-first header from before the Program
  // column existed, so a pre-existing file's header row is still stripped correctly either way).
  const hints = firstColHint ? (Array.isArray(firstColHint) ? firstColHint : [firstColHint]) : ["name"];
  const reader = new FileReader();
  reader.onload = ()=>{
    let rows;
    try{ rows = parseCsv(String(reader.result)); }
    catch(e){ alert("Could not read that file as CSV."); return; }
    if(rows.length===0){ alert("That file appears to be empty."); return; }
    const header = rows[0].map(h=>String(h).trim().toLowerCase());
    const dataRows = hints.includes(header[0]) ? rows.slice(1) : rows;
    const result = importFn(dataRows);
    alert(summaryFn(result));
  };
  reader.onerror = ()=> alert("Could not read that file.");
  reader.readAsText(file);
}

// Availability <-> compact text, e.g. "Mon 7:30 AM-5:00 PM; Wed 7:30 AM-5:00 PM"
function serializeAvailability(room){
  const parts = [];
  DAYS.forEach(d=>{
    const arr = room.availability[d];
    let start = null;
    for(let i=0;i<=NUM_SLOTS;i++){
      const on = i<NUM_SLOTS && arr[i];
      if(on && start===null) start = i;
      if(!on && start!==null){
        parts.push(`${d} ${fmtTime(SLOT_TIMES[start])}-${fmtTime(SLOT_TIMES[i-1]+SLOT_LEN)}`);
        start = null;
      }
    }
  });
  return parts.join("; ");
}
function parseTimeLabel(s){
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if(!m) return null;
  let h = parseInt(m[1],10) % 12;
  if(/pm/i.test(m[3])) h += 12;
  return h*60 + parseInt(m[2],10);
}
function parseAvailabilityString(str){
  if(!str || !String(str).trim()) return null; // blank = caller should default to standard hours
  const av = makeAvailability();
  DAYS.forEach(d=> av[d] = new Array(NUM_SLOTS).fill(false));
  String(str).split(";").map(s=>s.trim()).filter(Boolean).forEach(part=>{
    const m = part.match(/^(\w+)\s+(.+?)-(.+)$/);
    if(!m || !DAYS.includes(m[1])) return;
    const startMin = parseTimeLabel(m[2]), endMin = parseTimeLabel(m[3]);
    if(startMin==null || endMin==null) return;
    for(let i=0;i<NUM_SLOTS;i++){
      if(SLOT_TIMES[i] >= startMin && SLOT_TIMES[i] < endMin) av[m[1]][i] = true;
    }
  });
  return av;
}

/* --- Rooms --- */
function exportRoomsCsv(){
  if(state.rooms.length===0){ alert("No rooms to export yet."); return; }
  const rows = [["Name","Capacity","Availability","UsageLimitPercent","RoomType"]];
  state.rooms.forEach(r=> rows.push([r.name, r.capacity||"", serializeAvailability(r), r.usageLimitPercent==null?100:r.usageLimitPercent, r.roomType==="LEC"||r.roomType==="LAB" ? r.roomType : "BOTH"]));
  downloadCsv("rooms.csv", rows);
  trackEvent("exportRoomsCsv", { numRooms: state.rooms.length });
}
function downloadRoomsTemplate(){
  downloadCsv("rooms-template.csv", [
    ["Name","Capacity","Availability","UsageLimitPercent","RoomType"],
    ["Room 101","40","","100","BOTH"],
    ["Room 102","25","Mon 7:30 AM-5:00 PM; Wed 7:30 AM-5:00 PM","100","LEC"],
    ["Chemistry Lab","30","","100","LAB"],
    ["Shared Auditorium","120","","50","BOTH"]
  ]);
}
function importRoomsFromRows(dataRows){
  let added = 0;
  dataRows.forEach(cols=>{
    const name = (cols[0]||"").trim();
    if(!name) return;
    const capRaw = parseInt(cols[1],10);
    // UsageLimitPercent is a 4th, optional column — a 3-column file (from before this field
    // existed) is still fully valid and every room in it just defaults to 100%. RoomType is a
    // 5th, also-optional column — missing/unrecognized values default to BOTH.
    const usagePctRaw = parseInt(cols[3],10);
    const usageLimitPercent = (!isNaN(usagePctRaw) && usagePctRaw>=1 && usagePctRaw<=100) ? usagePctRaw : 100;
    const roomTypeRaw = (cols[4]||"").trim().toUpperCase();
    const roomType = (roomTypeRaw==="LEC"||roomTypeRaw==="LAB") ? roomTypeRaw : "BOTH";
    state.rooms.push({
      id: genId("room"), name,
      capacity: !isNaN(capRaw) && capRaw>0 ? capRaw : null,
      availability: parseAvailabilityString(cols[2]) || makeAvailability(),
      usageLimitPercent,
      roomType
    });
    added++;
  });
  saveState();
  renderRooms();
  trackEvent("importRoomsCsv", { numRooms: state.rooms.length, extra:{ added } });
  return added;
}

/* --- Subjects --- */
function exportSubjectsCsv(){
  if(state.subjects.length===0){ alert("No subjects to export yet."); return; }
  const rows = [["Code","Type","DurationMinutes","SessionsPerWeek","ClassSize","SplitPaired","DayPairPref","CapacitySplit","ExternalAssignment","Level"]];
  state.subjects.forEach(s=> rows.push([
    s.name, s.type, s.durationSlots*SLOT_LEN, s.sessionsPerWeek, s.size||"",
    s.isSplitPair ? "TRUE" : "FALSE", s.dayPairPref||"", s.isCapacitySplit ? "TRUE" : "FALSE",
    s.externalAssignment ? "TRUE" : "FALSE", s.level==="GRAD" ? "GRAD" : "UG"
  ]));
  downloadCsv("subjects.csv", rows);
  trackEvent("exportSubjectsCsv");
}
function downloadSubjectsTemplate(){
  downloadCsv("subjects-template.csv", [
    ["Code","Type","DurationMinutes","SessionsPerWeek","ClassSize","SplitPaired","DayPairPref","CapacitySplit","ExternalAssignment","Level"],
    ["MATH101","LEC","60","3","35","FALSE","","","","UG"],
    ["CHEM011L","LAB","180","2","35","FALSE","","TRUE","","UG"],
    ["BIO101","LEC","180","2","30","TRUE","AUTO","FALSE","","UG"],
    ["PE1","LEC","120","1","","FALSE","","","TRUE","UG"],
    ["GRAD501","LEC","90","2","20","FALSE","","","","GRAD"]
  ]);
}
function importSubjectsFromRows(dataRows){
  let added = 0, skipped = 0;
  const dayPairMap = {AUTO:"AUTO", MW:"MW", TTH:"TTh", FSA:"FSa"};
  dataRows.forEach(cols=>{
    const name = (cols[0]||"").trim();
    if(!name) return;
    const type = (cols[1]||"LEC").trim().toUpperCase()==="LAB" ? "LAB" : "LEC";
    const minutes = parseInt(cols[2],10);
    if(isNaN(minutes) || minutes<=0){ skipped++; return; }
    const durationSlots = clamp(Math.round(minutes/SLOT_LEN), 1, 8);
    let sessions = parseInt(cols[3],10);
    if(isNaN(sessions) || sessions<1) sessions = 1;
    sessions = Math.min(7, sessions);
    const sizeRaw = parseInt(cols[4],10);
    const size = !isNaN(sizeRaw) && sizeRaw>0 ? sizeRaw : null;
    const wantsSplit = (cols[5]||"").trim().toUpperCase()==="TRUE";
    const dayPairPref = dayPairMap[(cols[6]||"AUTO").trim().toUpperCase()] || "AUTO";
    const wantsCapacitySplit = (cols[7]||"").trim().toUpperCase()==="TRUE";
    const externalAssignment = (cols[8]||"").trim().toUpperCase()==="TRUE";
    const level = (cols[9]||"").trim().toUpperCase()==="GRAD" ? "GRAD" : "UG";

    // Mirror the Add Subject form's own invariants so imported rows behave exactly like
    // hand-added ones (split modes force their own duration/session values).
    let finalDurationSlots = durationSlots, finalSessions = sessions;
    let finalIsSplit = false, finalDayPairPref = null, finalIsCapacitySplit = false;
    if(type==="LEC" && wantsSplit){
      finalDurationSlots = 3; finalSessions = 2; finalIsSplit = true; finalDayPairPref = dayPairPref;
    } else if(type==="LAB" && wantsCapacitySplit){
      finalSessions = 2; finalIsCapacitySplit = true;
    }

    state.subjects.push(buildSubjectRecord(
      name, finalDurationSlots, finalSessions, size,
      finalIsSplit, finalDayPairPref, type, finalIsCapacitySplit, null, externalAssignment, level
    ));
    added++;
  });
  saveState();
  renderSubjects();
  trackEvent("importSubjectsCsv", { extra:{ added, skipped } });
  return { added, skipped };
}

/* --- Faculty --- */
function exportFacultyCsv(){
  if(state.faculty.length===0){ alert("No faculty to export yet."); return; }
  const subjectById = {};
  state.subjects.forEach(s=> subjectById[s.id] = s);
  const rows = [["Name","SubjectCodes","AdminResearchUnits"]];
  state.faculty.forEach(f=> rows.push([
    f.name, f.subjectIds.map(id=> subjectById[id] ? subjectCodeLabel(subjectById[id]) : null).filter(Boolean).join("; "),
    f.adminResearchUnits || 0
  ]));
  downloadCsv("faculty.csv", rows);
  trackEvent("exportFacultyCsv");
}
function downloadFacultyTemplate(){
  downloadCsv("faculty-template.csv", [
    ["Name","SubjectCodes","AdminResearchUnits"],
    ["Engr. Dela Cruz","MATH101; CHEM011L","6"],
    ["Engr. Santos","CHEM011L","0"]
  ]);
}
function importFacultyFromRows(dataRows){
  let added = 0, merged = 0, unmatchedRefs = 0, externalSkipped = 0;
  dataRows.forEach(cols=>{
    const name = (cols[0]||"").trim();
    if(!name) return;
    const subjectIds = [];
    (cols[1]||"").split(";").map(s=>s.trim()).filter(Boolean).forEach(subjName=>{
      const match = state.subjects.find(s=> subjectCodeLabel(s).toLowerCase()===subjName.toLowerCase());
      if(!match){ unmatchedRefs++; return; }
      // External-Assignment subjects have no faculty of ours to assign (faculty is TBD) —
      // the optimizer would never actually use this link, so don't silently create it.
      if(match.externalAssignment){ externalSkipped++; return; }
      subjectIds.push(match.id);
    });
    const adminRaw = parseFloat(cols[2]);
    const adminResearchUnits = !isNaN(adminRaw) && adminRaw>=0 ? adminRaw : 0;
    // A row whose name matches an existing (or already-imported-this-run) faculty member
    // merges its subjects into that record instead of creating a duplicate — same rule as
    // adding one by hand. Admin/Research Load Units is overwritten with this row's value.
    const existing = findFacultyByName(name);
    if(existing){
      const set = new Set(existing.subjectIds);
      subjectIds.forEach(id=> set.add(id));
      existing.subjectIds = Array.from(set);
      existing.adminResearchUnits = adminResearchUnits;
      merged++;
    } else {
      state.faculty.push({ id: genId("fac"), name, subjectIds, adminResearchUnits });
      added++;
    }
  });
  saveState();
  renderFaculty();
  trackEvent("importFacultyCsv", { extra:{ added, merged, unmatchedRefs, externalSkipped } });
  return { added, merged, unmatchedRefs, externalSkipped };
}

document.getElementById("rooms-export-btn").addEventListener("click", exportRoomsCsv);
document.getElementById("rooms-template-btn").addEventListener("click", downloadRoomsTemplate);
document.getElementById("rooms-import-btn").addEventListener("click", ()=> document.getElementById("rooms-import-file").click());
document.getElementById("rooms-import-file").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) handleCsvImport(file, importRoomsFromRows, (n)=> `Imported ${n} room(s).`);
  e.target.value = "";
});

document.getElementById("subjects-export-btn").addEventListener("click", exportSubjectsCsv);
document.getElementById("subjects-template-btn").addEventListener("click", downloadSubjectsTemplate);
document.getElementById("subjects-import-btn").addEventListener("click", ()=> document.getElementById("subjects-import-file").click());
document.getElementById("subjects-import-file").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) handleCsvImport(file, importSubjectsFromRows, (r)=>
    `Imported ${r.added} subject(s).${r.skipped ? ` Skipped ${r.skipped} row(s) with an invalid/missing duration.` : ""}`
  , "code");
  e.target.value = "";
});

document.getElementById("faculty-export-btn").addEventListener("click", exportFacultyCsv);
document.getElementById("faculty-template-btn").addEventListener("click", downloadFacultyTemplate);
document.getElementById("faculty-import-btn").addEventListener("click", ()=> document.getElementById("faculty-import-file").click());
document.getElementById("faculty-import-file").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) handleCsvImport(file, importFacultyFromRows, (r)=>
    `Imported ${r.added} faculty member(s).${r.merged ? ` ${r.merged} row(s) matched an existing faculty member and had their subjects merged in instead of duplicating.` : ""}${r.unmatchedRefs ? ` ${r.unmatchedRefs} subject reference(s) not found (import Subjects first, and make sure names match exactly).` : ""}${r.externalSkipped ? ` ${r.externalSkipped} reference(s) skipped — those subjects are marked External Assignment and don't need faculty.` : ""}`
  );
  e.target.value = "";
});

/* ---------------------------------------------------------------------
   INIT
--------------------------------------------------------------------- */
populateDurationSelect();
populateRoomHoursSelects(document.getElementById("room-open-from"), document.getElementById("room-open-until"));
refreshSplitUI();
document.getElementById("global-blocks-input").value = state.blocks;
renderRooms();
renderSubjects();
renderFaculty();
renderProspectus();
renderScheduleTab();
trackEvent("appLoad", { eventType:"page_view", numRooms: state.rooms.length, extra:{ numSubjects: state.subjects.length, numFaculty: state.faculty.length } });

})();
