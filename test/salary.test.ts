import test from "node:test";
import assert from "node:assert/strict";
import { formatSalary, parseSalary } from "../src/core/discover/salary.ts";

test("parseSalary reads the common pay-range formats", () => {
  const cases: [string, { min: number; max: number } | undefined][] = [
    ["The base salary range for this role is $138,000 - $192,000 USD.", { min: 138000, max: 192000 }],
    ["Pay range: $138,000—$192,000", { min: 138000, max: 192000 }],
    ["The typical base pay range for this position is USD $100,600 - $199,000 per year.", { min: 100600, max: 199000 }],
    ["The base salary range is 124,000 USD - 195,500 USD for Level 2.", { min: 124000, max: 195500 }],
    ["Compensation: $138K – $192K + equity", { min: 138000, max: 192000 }],
    ["Hourly pay: $45.00/hr - $60.00/hr", { min: 93600, max: 124800 }],
    ["Base pay of $129,300/year, plus benefits", { min: 129300, max: 129300 }],
    ["Salary: $120,000 to 150,000", { min: 120000, max: 150000 }],
    ["Pay ranges by location: NYC $150,000 - $200,000; Austin $130,000 - $175,000", { min: 130000, max: 200000 }],
  ];
  for (const [text, want] of cases) assert.deepEqual(parseSalary(text), want, text);
});

test("parseSalary ignores money that isn't pay", () => {
  assert.equal(parseSalary("We raised $5 million - $10 million in funding."), undefined);
  assert.equal(parseSalary("We have 2,000 - 3,000 customers."), undefined);
  assert.equal(parseSalary("A $500 - $1,000 learning stipend"), undefined, "too small to be a salary");
  assert.equal(parseSalary(""), undefined);
});

test("formatSalary", () => {
  assert.equal(formatSalary({ min: 138000, max: 192000 }), "$138k–$192k");
  assert.equal(formatSalary({ min: 129300, max: 129300 }), "$129k");
  assert.equal(formatSalary(undefined), "Not stated");
});
