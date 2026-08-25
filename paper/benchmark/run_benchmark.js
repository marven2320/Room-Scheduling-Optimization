"use strict";
const fs = require("fs");
const core = require("./optimizer_core.js");
const { generateProblem } = require("./generate.js");

const SCENARIOS = [
  { name: "Small",  numRooms: 3,  numSubjects: 10, numFaculty: 3 },
  { name: "Medium", numRooms: 5,  numSubjects: 25, numFaculty: 6 },
  { name: "Large",  numRooms: 8,  numSubjects: 40, numFaculty: 10 },
  { name: "XLarge", numRooms: 10, numSubjects: 55, numFaculty: 14 },
];
const TRIALS_PER_SCENARIO = 10;
const LOG = fs.createWriteStream(__dirname + "/benchmark_progress.log", { flags: "w" });
function log(s) { LOG.write(s + "\n"); }

function countSessions(subjects) {
  let total = 0;
  subjects.forEach(s => { total += s.isSplitPair ? 2 : s.sessionsPerWeek; });
  return total;
}

async function runOne(problem) {
  core.setState({
    rooms: problem.rooms,
    subjects: problem.subjects,
    faculty: problem.faculty,
    prospectus: [],
    targetTerm: "",
    blocks: 1,
    schedule: null,
  });

  // Greedy baseline: decode ONLY the most-constrained-first heuristic order, no GA evolution.
  const baseTasks = core.buildTasks(1);
  baseTasks.forEach((t, i) => (t.__gaId = i));
  const heuristicOrder = baseTasks.slice().sort((a, b) => (b.sortWeight - a.sortWeight) || ((b.size || 0) - (a.size || 0)));
  const tBase0 = performance.now();
  const baseResult = core.runTrial(heuristicOrder);
  const baseWallMs = performance.now() - tBase0;
  const baseFitness = core.scoreResult(baseResult);
  const baseTotalSessions = baseResult.scheduledCount + baseResult.unscheduled.length;

  // Full GA run.
  const t0 = performance.now();
  const result = await core.optimizeSchedule(null);
  const wallMs = performance.now() - t0;
  const totalSessions = result.scheduledCount + result.unscheduled.length;
  return {
    wallMs,
    generationsRun: result.generationsRun,
    populationSize: result.populationSize,
    scheduledCount: result.scheduledCount,
    totalSessions,
    placementRate: totalSessions ? result.scheduledCount / totalSessions : 1,
    gapScore: result.gapScore,
    activeRoomDayCount: result.activeRoomDayCount,
    lateLabCount: result.lateLabCount,
    fridayCount: result.fridayCount,
    facultyNoBreakCount: result.facultyNoBreakCount,
    facultyGapScore: result.facultyGapScore,
    fitness: core.scoreResult(result),
    baseline: {
      wallMs: baseWallMs,
      scheduledCount: baseResult.scheduledCount,
      totalSessions: baseTotalSessions,
      placementRate: baseTotalSessions ? baseResult.scheduledCount / baseTotalSessions : 1,
      gapScore: baseResult.gapScore,
      activeRoomDayCount: baseResult.activeRoomDayCount,
      lateLabCount: baseResult.lateLabCount,
      fridayCount: baseResult.fridayCount,
      facultyNoBreakCount: baseResult.facultyNoBreakCount,
      fitness: baseFitness,
    },
  };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) { const m = mean(arr); return Math.sqrt(mean(arr.map(x => (x - m) ** 2))); }
function summarize(runs, pick) { const vals = runs.map(pick); return { mean: mean(vals), std: std(vals) }; }

async function main() {
  const allResults = {};
  for (const scenario of SCENARIOS) {
    const runs = [];
    for (let trial = 0; trial < TRIALS_PER_SCENARIO; trial++) {
      const problem = generateProblem(scenario.name, { ...scenario, seed: scenario.name.charCodeAt(0) * 1000 + trial });
      const r = await runOne(problem);
      runs.push(r);
      log(`${scenario.name} trial ${trial + 1}/${TRIALS_PER_SCENARIO}: GA gen=${r.generationsRun} pop=${r.populationSize} placed=${r.scheduledCount}/${r.totalSessions} time=${r.wallMs.toFixed(1)}ms | baseline placed=${r.baseline.scheduledCount}/${r.baseline.totalSessions} fit=${r.baseline.fitness} vs GA fit=${r.fitness}`);
      fs.writeFileSync(__dirname + "/benchmark_results_partial.json", JSON.stringify(allResults, null, 2));
    }
    allResults[scenario.name] = {
      scenario,
      runs,
      summary: {
        placementRate: summarize(runs, r => r.placementRate),
        generationsRun: summarize(runs, r => r.generationsRun),
        populationSize: runs[0].populationSize,
        wallMs: summarize(runs, r => r.wallMs),
        gapScore: summarize(runs, r => r.gapScore),
        activeRoomDayCount: summarize(runs, r => r.activeRoomDayCount),
        lateLabCount: summarize(runs, r => r.lateLabCount),
        fridayCount: summarize(runs, r => r.fridayCount),
        facultyNoBreakCount: summarize(runs, r => r.facultyNoBreakCount),
        fitness: summarize(runs, r => r.fitness),
        totalSessions: runs[0].totalSessions,
        numRooms: scenario.numRooms, numFaculty: scenario.numFaculty, numSubjects: scenario.numSubjects,
        baseline: {
          placementRate: summarize(runs, r => r.baseline.placementRate),
          fitness: summarize(runs, r => r.baseline.fitness),
          gapScore: summarize(runs, r => r.baseline.gapScore),
          wallMs: summarize(runs, r => r.baseline.wallMs),
        },
      },
    };
    fs.writeFileSync(__dirname + "/benchmark_results.json", JSON.stringify(allResults, null, 2));
  }
  log("\n=== SUMMARY ===");
  for (const name of Object.keys(allResults)) {
    const s = allResults[name].summary;
    log(`${name}: sessions=${s.totalSessions} rooms=${s.numRooms} faculty=${s.numFaculty} | GA placement=${(s.placementRate.mean * 100).toFixed(1)}%+-${(s.placementRate.std * 100).toFixed(1)} gens=${s.generationsRun.mean.toFixed(1)}+-${s.generationsRun.std.toFixed(1)} pop=${s.populationSize} time=${s.wallMs.mean.toFixed(0)}+-${s.wallMs.std.toFixed(0)}ms | baseline placement=${(s.baseline.placementRate.mean * 100).toFixed(1)}% fitness GA=${s.fitness.mean.toFixed(0)} baseline=${s.baseline.fitness.mean.toFixed(0)}`);
  }
  LOG.end();
}

main().catch(e => { log("ERROR: " + e.stack); process.exit(1); });
