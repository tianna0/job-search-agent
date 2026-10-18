// Run with `npm run check-companies`.
// Reads every company's jobs for real and reports what works, so a site that
// changed is easy to spot. Slow sites (Microsoft) take a minute or two.
import { COMPANIES } from "../core/discover/companies.ts";
import { discoverCompany } from "../core/discover/discover.ts";

const only = process.argv.slice(2).map((s) => s.toLowerCase());
const pad = (s: string, n: number) => s.padEnd(n);

let ok = 0;
let broken = 0;
const manual: string[] = [];

console.log(`${pad("Company", 14)}${pad("Source", 12)}Result`);
console.log("-".repeat(80));

for (const c of COMPANIES) {
  if (only.length && !only.includes(c.id)) continue;
  if (!c.source) {
    manual.push(`${c.name}: ${c.note}`);
    continue;
  }
  const started = Date.now();
  try {
    const r = await discoverCompany(c, fetch);
    ok++;
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `${pad(c.name, 14)}${pad(c.source.kind, 12)}OK  ${r.listed} listed, ${r.matched.length} match, ` +
        `${r.requests} requests, ${secs}s` +
        ` (skipped: ${r.skipped.notSwe} not SWE, ${r.skipped.excluded} excluded, ${r.skipped.noSignal} no level signal` +
        (r.notChecked ? `, ${r.notChecked} not checked` : "") + ")"
    );
  } catch (err) {
    broken++;
    console.log(`${pad(c.name, 14)}${pad(c.source.kind, 12)}FAILED  ${(err as Error).message}`);
  }
}

console.log("-".repeat(80));
console.log(`${ok} readable, ${broken} failed.`);
if (manual.length) {
  console.log("\nNot read automatically:");
  for (const m of manual) console.log(`  ${m}`);
}
console.log("\nTip: check just a few with  npm run check-companies -- microsoft apple");
