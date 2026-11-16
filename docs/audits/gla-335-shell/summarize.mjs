import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const series = [];
for (const file of ['before.json', 'after.json', 'after-extra1.json', 'after-extra20.json']) {
  const data = JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  const groups = Map.groupBy(data.results, (run) => `${run.name}/${run.reducedMotion}`);
  for (const [key, runs] of groups) {
    if (runs.length < 10 || runs.some((run) => !Number.isFinite(run.cls))) {
      throw Error(`Incomplete or non-finite series: ${file} ${key}`);
    }
    const shifts = runs.flatMap((run) => run.shifts);
    const score = median(runs.map((run) => run.cls));
    series.push({
      file,
      scenario: runs[0].name,
      motion: runs[0].reducedMotion,
      count: runs.length,
      medianCls: score,
      gate: 0.01,
      pass: score <= 0.01,
      maxCls: Math.max(...runs.map((run) => run.cls)),
      maxRawShift: Math.max(0, ...shifts.map((shift) => shift.value)),
      maxRawShiftSum: Math.max(...runs.map((run) => run.shifts.reduce((sum, shift) => sum + shift.value, 0))),
      inputAssociatedShifts: shifts.filter((shift) => shift.hadRecentInput).length,
      uncaughtErrors: runs.flatMap((run) => run.errors),
    });
  }
}
writeFileSync(new URL('summary.json', root), JSON.stringify({ series }, null, 2) + '\n');
console.table(
  series.map(({ file, scenario, motion, count, medianCls, pass }) => ({
    file,
    scenario,
    motion,
    count,
    medianCls,
    pass,
  }))
);
