import test from "node:test";
import assert from "node:assert/strict";
import { categorize, classify, yearsMentions } from "../src/core/discover/classify.ts";

test("categories follow the seven title groups", () => {
  const cases: [string, string | null][] = [
    ["Full Stack Engineer", "Full-stack"],
    ["Fullstack Developer", "Full-stack"],
    ["Front-End Engineer", "Frontend"],
    ["Frontend Software Engineer", "Frontend"],
    ["UI Software Engineer", "Frontend"],
    ["Back End Engineer", "Backend"],
    ["Backend Engineer, Payments", "Backend"],
    ["SDET", "QA/SDET"],
    ["Software Engineer in Test", "QA/SDET"],
    ["Software Development Engineer in Test", "QA/SDET"],
    ["Quality Assurance Engineer", "QA/SDET"],
    ["QA Engineer II", "QA/SDET"],
    ["Test Automation Engineer", "QA/SDET"],
    ["Site Reliability Engineer, Apple Data Platform", "SRE/DevOps"],
    ["SRE II", "SRE/DevOps"],
    ["DevOps Engineer", "SRE/DevOps"],
    ["Software Engineer, SRE Tooling", "SRE/DevOps"],
    ["Software Development Engineer I", "SDE"],
    ["SDE II", "SDE"],
    ["Software Developer", "SDE"],
    ["Software Developer - Trading Systems", "SDE"],
    ["Software Engineer, New Grad", "SWE"],
    ["Data Scientist", null],
    ["Product Manager", null],
  ];
  for (const [title, want] of cases) assert.equal(categorize(title), want, title);
});

test("entry-level titles", () => {
  const titles = [
    "Software Engineer, New Grad",
    "Software Engineer - New College Grad 2027",
    "University Graduate Software Engineer",
    "Recent Graduate, Backend Engineer",
    "Early Career Software Engineer",
    "Entry Level Software Engineer",
    "Graduate Software Engineer",
    "Junior Frontend Engineer",
    "Associate Software Engineer",
    "Software Engineer I",
    "Software Engineer 1",
    "Software Development Engineer I",
    "SDE I",
    "SDE 1",
  ];
  for (const t of titles) assert.equal(classify(t).level, "entry", t);
});

test("maybe titles", () => {
  const titles = [
    "Software Engineer II",
    "SDE II",
    "Software Development Engineer II",
    "Software Engineer, IC3",
    "Software Engineer, Level 3",
    "Backend Engineer Level 4",
    "Member of Technical Staff, Backend",
  ];
  for (const t of titles) assert.equal(classify(t).level, "maybe", t);
});

test("title formats seen on Amazon and Netflix", () => {
  assert.equal(classify("Software Dev Engineer I, AWS").level, "entry");
  assert.equal(classify("Software Developer Engineer 1").level, "entry");
  assert.equal(classify("Software Dev Engineer II").level, "maybe");
  assert.equal(classify("Software Engineer 4 - Revenue Infrastructure").level, "maybe");
  assert.equal(classify("Software Engineer 3").level, "maybe");
  assert.equal(classify("Software Engineer, 3D Graphics").level, "unknown", "3D is not a level");
  assert.equal(classify("Software Development Engineer Intern, Amazon University").level, "excluded");
  assert.equal(classify("Software Engineer II/Sr. Software Engineer").level, "excluded");
  assert.equal(classify("Graphics Software Engineer", "BS + 10 years of relevant experience.").level, "excluded");
});

test("excluded titles", () => {
  const titles = [
    "Senior Software Engineer",
    "Sr. Backend Engineer",
    "Staff Software Engineer",
    "Software Engineering Lead",
    "Engineering Manager, Backend",
    "Software Engineer Intern",
    "Software Engineering Internship, Summer 2027",
    "Principal Software Engineer",
  ];
  for (const t of titles) assert.equal(classify(t).level, "excluded", t);
});

test("plain titles are decided by the job description", () => {
  assert.equal(classify("Software Engineer").level, "unknown");
  assert.equal(classify("Software Engineer", "We want 0-2 years of experience with Python.").level, "entry");
  assert.equal(classify("Software Engineer", "0-1 years of professional experience").level, "entry");
  assert.equal(classify("Software Engineer", "No prior experience required.").level, "entry");
  assert.equal(classify("Software Engineer", "2 years of experience building services").level, "entry");
  assert.equal(classify("Software Engineer", "1-3 years of relevant experience").level, "maybe");
  assert.equal(classify("Software Engineer", "3+ years of experience required").level, "excluded");
  assert.equal(classify("Software Engineer", "5 years of industry experience").level, "excluded");
});

test("a plain title whose JD doesn't state years is a Maybe", () => {
  const c = classify("Software Engineer, Payments", "You will build APIs in Go and work with product teams.");
  assert.equal(c.level, "maybe");
  assert.deepEqual(c.reasons, ["JD doesn't state years of experience"]);
  assert.equal(classify("Software Engineer, Payments").level, "unknown", "no description yet: fetch it first");
  assert.equal(classify("Product Designer", "Design things.").level, "unknown", "not a software role");
  assert.equal(classify("Senior Software Engineer", "Build APIs.").level, "excluded");
});

test("a 3+ year requirement overrides an entry-level title", () => {
  assert.equal(classify("Software Engineer I", "Requires 4+ years of experience").level, "excluded");
});

test("years that are not about experience are ignored", () => {
  assert.deepEqual(yearsMentions("Founded 10 years ago. We offer 3 years of vesting."), []);
  const c = classify("Software Engineer", "Our company has 12 years of history.");
  assert.equal(c.level, "maybe", "not an experience requirement, so the JD states no years");
  assert.deepEqual(c.reasons, ["JD doesn't state years of experience"]);
});

test("clearance and citizenship requirements are excluded", () => {
  assert.equal(classify("Software Engineer, New Grad", "Active TS/SCI clearance required").level, "excluded");
  assert.equal(classify("Software Engineer, New Grad", "Must be a U.S. citizen.").level, "excluded");
  assert.equal(classify("Software Engineer, New Grad", "U.S. citizenship is required").level, "excluded");
  assert.equal(classify("Software Engineer, New Grad", "Requires a security clearance").level, "excluded");
});

test("equal-opportunity wording about citizenship status is not a requirement", () => {
  const eeo = "We do not discriminate on the basis of race, religion, citizenship status, or veteran status.";
  assert.equal(classify("Software Engineer, New Grad", eeo).level, "entry");
});

test("a JD range demotes an entry title only when the title is not entry", () => {
  assert.equal(classify("Software Engineer", "1-3 years of experience").level, "maybe");
  assert.equal(classify("Software Engineer I", "1-3 years of experience").level, "entry");
});
