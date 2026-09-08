import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./lib/csv.mjs";
import {
  APPLICANT_HEADERS,
  SLOT_HEADERS,
  normalizeApplicantRow,
  normalizeSlotRow,
  validateSchedule,
} from "./lib/scheduler.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function exactHeaders(actual, expected, label) {
  if (actual.join("|") === expected.join("|")) return [];
  return [`${label} headers must be exactly: ${expected.join(",")}`];
}

async function main() {
  const applicantCsv = parseCsv(await fs.readFile(path.join(projectRoot, "data", "applicants.csv"), "utf8"));
  const slotCsv = parseCsv(await fs.readFile(path.join(projectRoot, "data", "slots.csv"), "utf8"));
  const config = JSON.parse(await fs.readFile(path.join(projectRoot, "config", "schedule.json"), "utf8"));
  const applicants = applicantCsv.rows.map(normalizeApplicantRow);
  const slots = slotCsv.rows.map(normalizeSlotRow);
  const validation = validateSchedule(applicants, slots, config);
  const errors = [
    ...exactHeaders(applicantCsv.headers, APPLICANT_HEADERS, "applicants.csv"),
    ...exactHeaders(slotCsv.headers, SLOT_HEADERS, "slots.csv"),
    ...validation.errors,
  ];
  console.log(
    JSON.stringify({
      applicants: applicants.length,
      slots: slots.length,
      errors: errors.length,
      warnings: validation.warnings,
    }),
  );
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

