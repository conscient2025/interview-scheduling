import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { parseCsv } from "./csv.mjs";
import {
  INTERVIEWER_HEADERS,
  compareInterviewerSnapshots,
  extractInterviewersFromValues,
  normalizeInterviewerRow,
  validateInterviewers,
} from "./interviewers.mjs";

function exactHeaders(actual, expected) {
  return actual.join("|") === expected.join("|");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readInterviewersFromWorkbook({ inputPath, slots, config }) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
  const sheet = workbook.worksheets.getItemAt(0);
  if (sheet.name !== "面试排班") throw new Error(`面试官来源工作表必须名为“面试排班”，当前为“${sheet.name}”`);
  const values = sheet.getUsedRange()?.values ?? [];
  if (!values.length) throw new Error("面试官来源排班表为空");
  return extractInterviewersFromValues(values, slots, config);
}

export async function loadLatestInterviewers({ interviewersPath, sourcePath, slots, config }) {
  const parsed = parseCsv(await fs.readFile(interviewersPath, "utf8"));
  if (!exactHeaders(parsed.headers, INTERVIEWER_HEADERS)) {
    throw new Error(`interviewers.csv headers must be exactly: ${INTERVIEWER_HEADERS.join(",")}`);
  }
  const existing = parsed.rows.map(normalizeInterviewerRow);
  const existingValidation = validateInterviewers(existing, slots, config);
  if (existingValidation.errors.length) throw new Error(existingValidation.errors.join("\n"));

  if (!(await fileExists(sourcePath))) {
    return {
      interviewers: existing,
      summary: { source: "csv", sourcePath, entries: existing.length, added: 0, updated: 0, removed: 0 },
    };
  }

  const interviewers = await readInterviewersFromWorkbook({ inputPath: sourcePath, slots, config });
  const validation = validateInterviewers(interviewers, slots, config);
  if (validation.errors.length) throw new Error(validation.errors.join("\n"));
  const changes = compareInterviewerSnapshots(existing, interviewers);
  return {
    interviewers,
    summary: { source: "xlsx", sourcePath, entries: interviewers.length, ...changes },
  };
}
