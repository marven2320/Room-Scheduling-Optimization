"use strict";
const fs = require("fs");
const core = require("./optimizer_core.js");
const { generateProblem } = require("./generate.js");

async function main() {
  const problem = generateProblem("Medium-trace", { numRooms: 5, numSubjects: 25, numFaculty: 6, seed: 777 });
  core.setState({ rooms: problem.rooms, subjects: problem.subjects, faculty: problem.faculty, prospectus: [], targetTerm: "", blocks: 1, schedule: null });
  const trace = [];
  const result = await core.optimizeSchedule((p) => {
    trace.push({ generation: p.generation, fitness: p.fitness, scheduledCount: p.scheduledCount, totalSessions: p.totalSessions, gapScore: p.gapScore, done: p.done });
  });
  fs.writeFileSync(__dirname + "/convergence_trace.json", JSON.stringify({ trace, final: { generationsRun: result.generationsRun, populationSize: result.populationSize } }, null, 2));
  console.log("generations:", result.generationsRun, "popSize:", result.populationSize);
  console.log("first:", trace[0]);
  console.log("last:", trace[trace.length - 1]);
}
main();
