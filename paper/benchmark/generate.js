"use strict";
const core = require("./optimizer_core.js");
const { makeAvailability } = core;

function seedRandom(seed) {
  // Mulberry32 PRNG for reproducible synthetic problem generation.
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genId(prefix, rnd) { return prefix + "_" + Math.floor(rnd() * 1e9).toString(36); }

function buildRooms(n, rnd) {
  const rooms = [];
  for (let i = 0; i < n; i++) {
    const roll = rnd();
    const roomType = roll < 0.15 ? "LEC" : (roll < 0.30 ? "LAB" : "BOTH");
    rooms.push({
      id: genId("room", rnd),
      name: `Room ${i + 1}`,
      capacity: 30 + Math.floor(rnd() * 21), // 30-50
      availability: makeAvailability(),
      usageLimitPercent: 100,
      roomType,
    });
  }
  return rooms;
}

function buildFaculty(n, rnd) {
  const fac = [];
  for (let i = 0; i < n; i++) fac.push({ id: genId("fac", rnd), name: `Faculty ${i + 1}`, subjectIds: [] });
  return fac;
}

function buildSubjects(n, faculty, rnd) {
  const subjects = [];
  for (let i = 0; i < n; i++) {
    const isLab = rnd() < 0.35;
    const isExternal = rnd() < 0.05;
    let durationSlots, sessionsPerWeek, isSplitPair, isCapacitySplit;
    if (isLab) {
      durationSlots = 6; // 3 hours
      isCapacitySplit = rnd() < 0.2;
      sessionsPerWeek = isCapacitySplit ? 2 : (rnd() < 0.3 ? 2 : 1);
      isSplitPair = false;
    } else {
      const splitEligible = rnd() < 0.5;
      if (splitEligible) {
        durationSlots = 3; // 1.5h x2 (paired)
        isSplitPair = true;
        sessionsPerWeek = 2;
        isCapacitySplit = false;
      } else {
        durationSlots = [2, 4, 6][Math.floor(rnd() * 3)];
        sessionsPerWeek = 1;
        isSplitPair = false;
        isCapacitySplit = false;
      }
    }
    const size = 20 + Math.floor(rnd() * 26); // 20-45
    const subj = {
      id: genId("subj", rnd),
      name: `SUBJ${String(i + 1).padStart(3, "0")}`,
      durationSlots, sessionsPerWeek,
      size,
      color: "#000",
      isSplitPair, dayPairPref: isSplitPair ? "AUTO" : null,
      type: isLab ? "LAB" : "LEC",
      isCapacitySplit,
      prospectusCourseId: null,
      externalAssignment: isExternal,
    };
    subjects.push(subj);
    if (!isExternal && faculty.length) {
      const f = faculty[i % faculty.length];
      f.subjectIds.push(subj.id);
    }
  }
  return subjects;
}

function generateProblem(name, { numRooms, numSubjects, numFaculty, seed }) {
  const rnd = seedRandom(seed);
  const rooms = buildRooms(numRooms, rnd);
  const faculty = buildFaculty(numFaculty, rnd);
  const subjects = buildSubjects(numSubjects, faculty, rnd);
  return { name, rooms, subjects, faculty };
}

module.exports = { generateProblem, seedRandom };
