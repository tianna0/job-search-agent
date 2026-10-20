// Pay ranges from job descriptions. US pay-transparency laws mean most postings
// for US roles state a range somewhere in the text, in many shapes:
//   "$138,000 - $192,000 USD"        Greenhouse
//   "USD $100,600 - $199,000 per year"  Microsoft
//   "124,000 USD - 195,500 USD"      Workday (Nvidia)
//   "$138K–$192K"                    Ashby summaries
//   "$45.00/hr - $60.00/hr"          hourly roles
//   "$129,300/year"                  a single figure
// Only amounts near pay words count, so "$5 million in funding" is ignored.
// Hourly rates are turned into annual pay (x 2,080 hours).

export interface Salary {
  /** Annual USD. */
  min: number;
  max: number;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*([kK])?`;
const PRE = String.raw`(?:USD\s*|US)?\$\s?`;
const SEP = String.raw`\s*(?:-|–|—|to|and)\s*`;
const POST = String.raw`(?:\s*(?:USD|/\s*(?:hr|hour|year|yr)|per\s+(?:hour|year|annum)))*`;

const RANGE_DOLLAR = new RegExp(`${PRE}${NUM}${POST}${SEP}(?:${PRE})?${NUM}${POST}`, "gi");
const RANGE_USD = new RegExp(`${NUM}\\s*USD${SEP}${NUM}\\s*USD`, "gi");
const SINGLE = new RegExp(`${PRE}${NUM}\\s*(?:/\\s*(?:hr|hour|year|yr)\\b|per\\s+(?:hour|year|annum)|annually|an hour)`, "gi");

const PAY_WORDS = /salary|pay|compensation|base|range|annual|wage|hourly|\bote\b|earn|hiring/i;
const NOT_PAY = /^\s*(?:million|billion|m\b|b\b|bn\b)/i;

function amount(num: string, k: string | undefined): number {
  return Number(num.replace(/,/g, "")) * (k ? 1000 : 1);
}

/** Annual figure, or null when it isn't plausibly a salary. */
function annual(value: number, hourly: boolean): number | null {
  const v = hourly ? value * 2080 : value;
  return v >= 20000 && v <= 2000000 ? Math.round(v) : null;
}

export function parseSalary(text: string): Salary | undefined {
  if (!text) return undefined;
  let min = Infinity;
  let max = -Infinity;
  const take = (lo: number, hi: number) => {
    min = Math.min(min, lo, hi);
    max = Math.max(max, lo, hi);
  };
  const context = (index: number, length: number) => ({
    before: text.slice(Math.max(0, index - 200), index),
    after: text.slice(index + length, index + length + 40),
    self: text.slice(index, index + length),
  });
  const isHourly = (c: { self: string; after: string }, a: number, b: number) =>
    /hour|\bhr\b|hourly/i.test(c.self + c.after.slice(0, 15)) || (a < 500 && b < 500);

  for (const re of [RANGE_DOLLAR, RANGE_USD]) {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
      const c = context(m.index, m[0].length);
      if (NOT_PAY.test(c.after) || !PAY_WORDS.test(c.before + c.self + c.after)) continue;
      const a = amount(m[1], m[2]);
      const b = amount(m[3], m[4]);
      const hourly = isHourly(c, a, b);
      const lo = annual(a, hourly);
      const hi = annual(b, hourly);
      if (lo !== null && hi !== null && lo <= hi) take(lo, hi);
    }
  }
  if (min === Infinity) {
    SINGLE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = SINGLE.exec(text)); ) {
      const c = context(m.index, m[0].length);
      if (!PAY_WORDS.test(c.before + c.self)) continue;
      const v = annual(amount(m[1], m[2]), /hour|\bhr\b/i.test(m[0]));
      if (v !== null) take(v, v);
    }
  }
  return min === Infinity ? undefined : { min, max };
}

/** "$138k–$192k", "$129k", or "Not stated". */
export function formatSalary(s: Salary | undefined): string {
  if (!s) return "Not stated";
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  return s.min === s.max ? k(s.min) : `${k(s.min)}–${k(s.max)}`;
}
