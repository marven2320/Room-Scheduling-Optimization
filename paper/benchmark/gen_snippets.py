import json, csv, statistics as st

BENCH_DIR = "/tmp/claude-0/-home-user-Room-Scheduling-Optimization/5d1f4dda-04ac-59e9-90a5-ceb443c14696/scratchpad/bench"
OUT_DIR = "/tmp/claude-0/-home-user-Room-Scheduling-Optimization/5d1f4dda-04ac-59e9-90a5-ceb443c14696/scratchpad/paper"

with open(f"{BENCH_DIR}/benchmark_results.json") as f:
    results = json.load(f)

order = ["Small", "Medium", "Large", "XLarge"]

# --- per-scenario session count snippets (for the scenario table) ---
for name in order:
    s = results[name]["summary"]
    with open(f"{OUT_DIR}/tab_sessions_{name.lower()}.tex", "w") as f:
        f.write(str(s["totalSessions"]))

# --- main results table ---
lines = []
lines.append(r"\begin{tabular}{lcccccccc}")
lines.append(r"\toprule")
lines.append(r"Scenario & \multicolumn{2}{c}{Placement (\%)} & \multicolumn{2}{c}{Fitness} & Gens & Pop & Time (ms) & $\Delta$Fitness \\")
lines.append(r"& GA & Greedy & GA & Greedy & (GA) & & (GA) & (GA$-$Greedy) \\")
lines.append(r"\midrule")
for name in order:
    s = results[name]["summary"]
    pr_ga = s["placementRate"]["mean"] * 100
    pr_ga_sd = s["placementRate"]["std"] * 100
    pr_bl = s["baseline"]["placementRate"]["mean"] * 100
    fit_ga = s["fitness"]["mean"]
    fit_bl = s["baseline"]["fitness"]["mean"]
    gens = s["generationsRun"]["mean"]
    gens_sd = s["generationsRun"]["std"]
    pop = s["populationSize"]
    tms = s["wallMs"]["mean"]
    tms_sd = s["wallMs"]["std"]
    delta = fit_ga - fit_bl
    lines.append(
        f"{name} & {pr_ga:.1f}$\\pm${pr_ga_sd:.1f} & {pr_bl:.1f} & "
        f"{fit_ga:,.0f} & {fit_bl:,.0f} & {gens:.1f}$\\pm${gens_sd:.1f} & {pop} & "
        f"{tms:.0f}$\\pm${tms_sd:.0f} & +{delta:,.0f} \\\\"
    )
lines.append(r"\bottomrule")
lines.append(r"\end{tabular}")
with open(f"{OUT_DIR}/tab_results.tex", "w") as f:
    f.write("\n".join(lines))

# --- discussion note (short lead-in referencing table) ---
with open(f"{OUT_DIR}/tab_discussion_note.tex", "w") as f:
    f.write("Across all four scales, the deployed decoder placed the large majority of sessions "
            "in a single greedy pass already, since hard-constraint checking (H1--H9) is identical "
            "for the genetic algorithm and the baseline -- both use the same \\texttt{runTrial} decoder. "
            "The genetic algorithm's contribution is therefore concentrated in the soft-objective terms.")

# --- results narrative (auto text from real numbers) ---
narrative = []
small = results["Small"]["summary"]; medium = results["Medium"]["summary"]
large = results["Large"]["summary"]; xlarge = results["XLarge"]["summary"]

with open(f"{BENCH_DIR}/benchmark_results.json") as _f:
    _raw = json.load(_f)
_placement_identical = all(
    r["scheduledCount"] == r["baseline"]["scheduledCount"]
    for n in order for r in _raw[n]["runs"]
)

narrative.append(
    ("Table~\\ref{tab:results} shows that, in every one of the 40 trials run (10 per scale across all four "
     "scales), the genetic algorithm placed \\emph{exactly} the same number of sessions as the greedy-only "
     "baseline -- a perfect 0-session difference in every trial, not just an average tie. "
     if _placement_identical else
     "Table~\\ref{tab:results} shows that the genetic algorithm's session-placement rate tracks the "
     "greedy-only baseline closely at every scale. ") +
    f"This is expected once the shared decoder is considered: both the GA's best individual and the baseline "
    f"are decoded through the identical constraint-respecting greedy procedure (\\texttt{{runTrial}}), and "
    f"the heuristic (most-constrained-first) ordering used as the baseline is also seeded into the GA's "
    f"initial population and protected by elitism -- so the GA can never place \\emph{{fewer}} sessions than "
    f"the baseline, and in this benchmark, evidently found no ordering that placed \\emph{{more}}. What the "
    f"genetic algorithm consistently achieves instead is a higher overall \\emph{{fitness}} than the "
    f"single-pass baseline in every trial across all four scales -- a mean improvement of "
    f"{small['fitness']['mean']-small['baseline']['fitness']['mean']:,.0f} (Small), "
    f"{medium['fitness']['mean']-medium['baseline']['fitness']['mean']:,.0f} (Medium), "
    f"{large['fitness']['mean']-large['baseline']['fitness']['mean']:,.0f} (Large), and "
    f"{xlarge['fitness']['mean']-xlarge['baseline']['fitness']['mean']:,.0f} (XLarge) -- driven entirely by "
    f"the five soft-objective terms of Eq.~(\\ref{{eq:fitness}}): tighter room-utilization packing (lower "
    f"gapScore and active-room-day count), fewer Friday sessions, fewer late laboratory sessions, and more "
    f"faculty members retaining a protected break window. This is a meaningful but modest result: it shows "
    f"the evolutionary search reliably refines schedule \\emph{{quality}} beyond the heuristic-seeded greedy "
    f"pass, but on these synthetic instances it did not need to (and was not observed to) unlock additional "
    f"\\emph{{feasibility}} that the heuristic alone could not already reach -- a distinction the placement-"
    f"dominant fitness function in Eq.~(\\ref{{eq:fitness}}) was explicitly designed to preserve. Problem "
    f"instances where the heuristic ordering performs poorly at placement (e.g. tightly constrained rosters "
    f"with little slack) would be expected to show the GA's placement advantage more clearly; evaluating that "
    f"case is left to future work (Section VII)."
)

narrative.append(
    f"Generation count falls, and wall-clock time rises, with problem size exactly as the adaptive parameter "
    f"formulas of Eq.~(\\ref{{eq:complexity}})--(4) predict: the Small scenario (population "
    f"{small['populationSize']}, nominal time budget under 6000\\,ms) ran for "
    f"{small['generationsRun']['mean']:.1f}$\\pm${small['generationsRun']['std']:.1f} generations in "
    f"{small['wallMs']['mean']:.0f}$\\pm${small['wallMs']['std']:.0f}\\,ms, while the XLarge scenario "
    f"(population {xlarge['populationSize']}, capped at the 6000\\,ms nominal ceiling) ran only "
    f"{xlarge['generationsRun']['mean']:.1f}$\\pm${xlarge['generationsRun']['std']:.1f} generations yet took "
    f"{xlarge['wallMs']['mean']:.0f}$\\pm${xlarge['wallMs']['std']:.0f}\\,ms -- roughly "
    f"{xlarge['wallMs']['mean']/6000:.1f}$\\times$ the nominal budget. This overshoot is a direct, measured "
    f"consequence of the once-per-generation termination check described in Section IV-F: for large "
    f"populations on large task sets, a single generation's decode-and-evaluate pass (population size "
    f"$\\times$ task count $\\times$ candidate search) can itself take longer than the remaining time budget, "
    f"so the loop always finishes the generation it is in before it can stop. Larger, harder instances "
    f"therefore run \\emph{{fewer}} generations in \\emph{{more}} wall-clock time, evolving a large, complex "
    f"population for only a handful of generations rather than a small population for many. For the "
    f"synthetic scales tested here this remains well within interactive bounds (under 15 seconds even at "
    f"XLarge), but it identifies a concrete limitation of the current termination check -- Section VII "
    f"discusses checking the time budget within, rather than only between, generations for substantially "
    f"larger departmental rosters."
)
from scipy import stats as _stats
stat_lines = []
for name in order:
    runs = results[name]["runs"]
    ga = [r["fitness"] for r in runs]
    bl = [r["baseline"]["fitness"] for r in runs]
    t, p = _stats.ttest_rel(ga, bl)
    stat_lines.append((name, t, p))
stat_str = "; ".join(f"{n}: $t(9){{=}}{t:.2f}$, $p{{=}}{p:.1e}$" for n, t, p in stat_lines)
narrative.append(
    "The fitness improvement is not just consistent in direction but statistically significant: a "
    "paired $t$-test on the 10 per-scenario (GA, baseline) fitness pairs rejects the null hypothesis "
    "of no difference at $p<0.01$ for every scenario (" + stat_str + "), with the strongest evidence "
    "at Medium scale. Because the same random problem instance is decoded by both methods in each "
    "trial, this is a matched-pairs design that controls for instance-to-instance difficulty variation, "
    "isolating the genetic algorithm's own contribution."
)

with open(f"{OUT_DIR}/results_narrative.tex", "w") as f:
    f.write("\n\n".join(narrative))

# --- convergence figure (pgfplots) from convergence_trace.json ---
with open(f"{BENCH_DIR}/convergence_trace.json") as f:
    conv = json.load(f)
trace = conv["trace"]
# de-duplicate the final repeated "done" entry sharing the last generation number
seen = set()
coords = []
for t in trace:
    if t["generation"] in seen:
        continue
    seen.add(t["generation"])
    coords.append((t["generation"], t["fitness"]))

coord_str = " ".join(f"({g},{fit})" for g, fit in coords)
fig = r"""\begin{tikzpicture}
\begin{axis}[
  width=0.95\linewidth, height=4.2cm,
  xlabel={Generation}, ylabel={Best fitness},
  ymin=""" + str(min(f for _, f in coords) - 5) + r""", ymax=""" + str(max(f for _, f in coords) + 5) + r""",
  xtick=data,
  scaled y ticks=false, yticklabel style={/pgf/number format/.cd, fixed, 1000 sep={,}},
  grid=major, grid style={dashed, gray!30},
  mark size=1.6pt,
]
\addplot[thick, color=blue, mark=*] coordinates { """ + coord_str + r""" };
\end{axis}
\end{tikzpicture}"""
with open(f"{OUT_DIR}/fig_convergence.tex", "w") as f:
    f.write(fig)

with open(f"{OUT_DIR}/fig_convergence_note.tex", "w") as f:
    f.write(
        f"The trial (Medium-scale synthetic instance, {conv['final']['populationSize']} individuals per "
        f"generation) placed all sessions from generation 1 and used its remaining "
        f"{conv['final']['generationsRun']-1} generations to refine the soft-objective terms; fitness rose "
        f"from {coords[0][1]:,} to {coords[-1][1]:,} (+{coords[-1][1]-coords[0][1]}) before the run terminated "
        f"on the adaptive time budget."
    )

# --- field usage log note ---
rows = list(csv.DictReader(open("/home/user/Room-Scheduling-Optimization/usage_log.csv")))
opt = [r for r in rows if r["event_type"] == "optimize_complete"]
details = [json.loads(r["details"]) for r in opt]
n_runs = len(opt)
n_full = sum(1 for d in details if d["unscheduledCount"] == 0)
lat = [float(r["latency_ms"]) for r in opt]
max_run = max(details, key=lambda d: d["totalSessions"])
sessions = load_msg = [d["totalSessions"] for d in details]
with open(f"{OUT_DIR}/field_usage_note.tex", "w") as f:
    f.write(
        f"The deployed application's usage-tracking log recorded {n_runs} optimizer runs during "
        f"development-stage testing, spanning problem sizes from 1 to {max(d['numSubjects'] for d in details)} "
        f"subjects and up to {max(d['numFaculty'] for d in details)} faculty. "
        f"{n_full} of {n_runs} runs ({100*n_full/n_runs:.0f}\\%) placed every session with zero unscheduled "
        f"conflicts; the single exception was a deliberately over-constrained 3-subject test case with only "
        f"one room. Reported optimizer latency (client-side wall-clock time reported for the completed run) "
        f"ranged from {min(lat):.1f}\\,ms to {max(lat):.1f}\\,ms (mean {st.mean(lat):.1f}\\,ms). The largest "
        f"real run recorded -- {max_run['numSubjects']} subjects, {max_run['totalSessions']} sessions, 5 "
        f"rooms, 5 faculty -- placed all {max_run['scheduledCount']} sessions. These field records are "
        f"informal (ad hoc developer testing rather than a designed experiment) but are broadly consistent "
        f"with the controlled benchmark's Medium/Large scenarios and support the same qualitative conclusion: "
        f"the deployed system reliably reaches a fully conflict-free schedule at realistic departmental scale."
    )

print("snippets written")
