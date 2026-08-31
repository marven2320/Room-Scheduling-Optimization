// Extracted, unmodified core scheduling/optimizer logic from app.js
// (Room Scheduling Optimization System) for standalone benchmarking.
"use strict";
let state = {
  rooms: [],
  subjects: [],
  faculty: [],
  prospectus: [],
  targetTerm: "",
  blocks: 1,
  schedule: null
};
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

function subjectCodeLabel(s){
  if(s.prospectusCourseId){
    const course = state.prospectus.find(c=>c.id===s.prospectusCourseId);
    if(course && course.code) return course.code;
  }
  return s.name;
}
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
          sortWeight: s.durationSlots*2, facultyIds, isCohort, cohortGroup, externalAssignment, allowSunday
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
            facultyIds, isCohort, cohortGroup, externalAssignment, allowSunday
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
function pickFreeFaculty(facultyIds, facultyOcc, days, start, durationSlots){
  const freeOnes = facultyIds.filter(fid=>{
    return days.every(day=>{
      const arr = facultyOcc[fid][day];
      for(let k=0;k<durationSlots;k++){ if(arr[start+k]) return false; }
      return true;
    });
  });
  if(freeOnes.length===0) return null;
  return freeOnes[Math.floor(Math.random()*freeOnes.length)];
}

// Room Type is a hard constraint: "LEC" or "LAB" only ever hosts that one subject type;
// "BOTH" (default, incl. any room predating this field) hosts either.
function roomAllowsType(room, subjectType){
  const rt = room.roomType==="LEC"||room.roomType==="LAB" ? room.roomType : "BOTH";
  return rt==="BOTH" || rt===subjectType;
}

function findCandidates(room, day, durationSlots, occ, size, usedDaysForSubject, facultyIds, facultyOcc, isCohort, cohortOcc, subjectType){
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
      facultyId = pickFreeFaculty(facultyIds, facultyOcc, [day], start, durationSlots);
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
function findPairedCandidates(room, pairKey, durationSlots, occ, size, facultyIds, facultyOcc, isCohort, cohortOcc, subjectType){
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
      facultyId = pickFreeFaculty(facultyIds, facultyOcc, [d1,d2], start, durationSlots);
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
          allCandidates = allCandidates.concat(findPairedCandidates(room, pk, task.durationSlots, occ, task.size, task.facultyIds, facultyOcc, task.isCohort, groupOcc, task.subjectType));
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
        const cands = findCandidates(room, day, task.durationSlots, occ, task.size, usedDays[task.instanceKey], task.facultyIds, facultyOcc, task.isCohort, groupOcc, task.subjectType);
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

module.exports = { state, buildTasks, optimizeSchedule, runTrial, scoreResult, makeAvailability, DAYS, SLOT_TIMES, NUM_SLOTS, setState(s){ state = Object.assign(state, s); } };
