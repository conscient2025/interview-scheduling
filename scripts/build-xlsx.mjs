import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { parseCsv, stringifyCsv } from "./lib/csv.mjs";
import { loadLatestInterviewers } from "./lib/interviewer-workbook.mjs";
import {
  INTERVIEWER_HEADERS,
  normalizeInterviewerRow,
  validateInterviewers,
} from "./lib/interviewers.mjs";
import { normalizeApplicantRow, normalizeSlotRow, validateSchedule } from "./lib/scheduler.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function weekdayName(dateText) {
  const names = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return names[new Date(`${dateText}T12:00:00+08:00`).getDay()];
}

function displayDate(dateText) {
  const [, month, day] = dateText.match(/^\d{4}-(\d{2})-(\d{2})$/) ?? [];
  return `${Number(month)}月${Number(day)}日`;
}

export function buildScheduleWorkbook({ applicants, interviewers = [], slots, config }) {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("面试排班");
  const fontFamily = "Microsoft YaHei";
  const colors = {
    text: "#1F2937",
    muted: "#6B7280",
    rule: "#94A3B8",
    border: "#64748B",
    section: "#334155",
    yellow: "#FDE68A",
    yellowPale: "#FFFBEB",
    blue: "#BAE6FD",
    blueHeader: "#E0F2FE",
    white: "#FFFFFF",
  };
  const borderAll = { preset: "all", style: "thin", color: colors.border };

  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(2);
  sheet.getRange("A1:P1").format.borders = { bottom: { style: "medium", color: colors.rule } };
  sheet.getRange("A1").values = [[config.title]];
  sheet.getRange("A1").format = {
    font: { name: fontFamily, size: 16, bold: true, color: colors.text },
    verticalAlignment: "center",
  };
  sheet.getRange("A1:P1").format.rowHeight = 28;
  sheet.mergeCells("A2:P2");
  sheet.getRange("A2").values = [["备注栏"]];
  sheet.getRange("A2:P2").format = {
    font: { name: fontFamily, size: 9, italic: true, color: colors.muted },
    verticalAlignment: "center",
  };
  sheet.getRange("A2:P2").format.rowHeight = 24;
  sheet.getRange("A3:P3").format.rowHeight = 8;
  sheet.getRange("A:A").format.columnWidth = 10;
  sheet.getRange("B:B").format.columnWidth = 15;
  sheet.getRange("C:H").format.columnWidth = 12;
  sheet.getRange("I:I").format.columnWidth = 3;
  sheet.getRange("J:P").format.columnWidth = 10.5;

  const applicantsBySlot = new Map();
  for (const applicant of applicants) {
    if (!applicant.assigned_slot) continue;
    if (!applicantsBySlot.has(applicant.assigned_slot)) applicantsBySlot.set(applicant.assigned_slot, []);
    applicantsBySlot.get(applicant.assigned_slot).push(applicant);
  }
  for (const members of applicantsBySlot.values()) {
    members.sort((left, right) => Number(left.seat_no) - Number(right.seat_no));
  }
  const interviewersBySlotAndDepartment = new Map(
    interviewers.map((item) => [`${item.slot_id}\u0000${item.department}`, item.interviewers]),
  );

  const dates = [...new Set(slots.map((slot) => slot.date))];
  let row = 4;
  for (const date of dates) {
    const dateSlots = slots.filter((slot) => slot.date === date).sort((left, right) => left.display_order - right.display_order);
    const bandRow = row;
    const headerRow = row + 1;
    const firstDataRow = row + 2;
    const lastDataRow = firstDataRow + dateSlots.length - 1;
    const blockLabel = dateSlots.some((slot) => slot.period === "morning") ? "全天" : "晚间";

    sheet.mergeCells(`A${bandRow}:B${bandRow}`);
    sheet.mergeCells(`C${bandRow}:H${bandRow}`);
    sheet.mergeCells(`J${bandRow}:P${bandRow}`);
    sheet.getRange(`A${bandRow}`).values = [[`${blockLabel} · ${weekdayName(date)}｜地点：________`]];
    sheet.getRange(`C${bandRow}`).values = [["面试官安排"]];
    sheet.getRange(`J${bandRow}`).values = [["候选人安排"]];
    sheet.getRange(`A${bandRow}:B${bandRow}`).format = {
      fill: colors.yellow,
      font: { name: fontFamily, size: 10, bold: true, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };
    for (const range of [`C${bandRow}:H${bandRow}`, `J${bandRow}:P${bandRow}`]) {
      sheet.getRange(range).format = {
        fill: colors.section,
        font: { name: fontFamily, size: 10, bold: true, color: colors.white },
        horizontalAlignment: "center",
        verticalAlignment: "center",
        borders: borderAll,
      };
    }
    sheet.getRange(`A${bandRow}:P${bandRow}`).format.rowHeight = 22;

    sheet.getRange(`A${headerRow}:H${headerRow}`).values = [["日期", "时间", ...config.departments]];
    sheet.getRange(`J${headerRow}:P${headerRow}`).values = [[1, 2, 3, 4, 5, 6, 7]];
    sheet.getRange(`A${headerRow}:H${headerRow}`).format = {
      fill: colors.yellowPale,
      font: { name: fontFamily, size: 9, bold: true, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };
    sheet.getRange(`J${headerRow}:P${headerRow}`).format = {
      fill: colors.blueHeader,
      font: { name: fontFamily, size: 9, bold: true, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };
    sheet.getRange(`A${headerRow}:P${headerRow}`).format.rowHeight = 22;

    sheet.mergeCells(`A${firstDataRow}:A${lastDataRow}`);
    sheet.getRange(`A${firstDataRow}`).values = [[displayDate(date)]];
    sheet.getRange(`A${firstDataRow}:A${lastDataRow}`).format = {
      fill: colors.white,
      font: { name: fontFamily, size: 10, bold: true, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };
    sheet.getRange(`B${firstDataRow}:B${lastDataRow}`).values = dateSlots.map((slot) => [`${slot.start}-${slot.end}`]);
    sheet.getRange(`B${firstDataRow}:B${lastDataRow}`).format = {
      fill: colors.white,
      font: { name: fontFamily, size: 9, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };
    sheet.getRange(`C${firstDataRow}:H${lastDataRow}`).format = {
      fill: colors.white,
      font: { name: fontFamily, size: 10, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };
    sheet.getRange(`C${firstDataRow}:H${lastDataRow}`).values = dateSlots.map((slot) =>
      config.departments.map(
        (department) => interviewersBySlotAndDepartment.get(`${slot.slot_id}\u0000${department}`) ?? "",
      ),
    );
    sheet.getRange(`J${firstDataRow}:N${lastDataRow}`).format = {
      fill: colors.blue,
      font: { name: fontFamily, size: 10, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };
    sheet.getRange(`O${firstDataRow}:P${lastDataRow}`).format = {
      fill: colors.white,
      font: { name: fontFamily, size: 10, color: colors.text },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      borders: borderAll,
    };

    const candidateValues = dateSlots.map((slot) => {
      const cells = Array(config.displaySeatColumns).fill("");
      for (const applicant of applicantsBySlot.get(slot.slot_id) ?? []) {
        const seat = Number(applicant.seat_no);
        if (seat >= 1 && seat <= config.displaySeatColumns) cells[seat - 1] = applicant.name;
      }
      return cells;
    });
    sheet.getRange(`J${firstDataRow}:P${lastDataRow}`).values = candidateValues;
    sheet.getRange(`A${firstDataRow}:P${lastDataRow}`).format.rowHeight = 21;
    sheet.getRange(`A${bandRow}:P${lastDataRow}`).format.wrapText = true;
    sheet.getRange(`A${bandRow}:P${lastDataRow}`).format.verticalAlignment = "center";
    sheet.getRange(`A${lastDataRow + 1}:P${lastDataRow + 1}`).format.rowHeight = 8;
    row = lastDataRow + 2;
  }

  return { workbook, sheet, lastRow: row - 1 };
}

export async function writeScheduleWorkbook({ applicants, interviewers = [], slots, config, outputPath, previewPath }) {
  const { workbook, lastRow } = buildScheduleWorkbook({ applicants, interviewers, slots, config });
  workbook.recalculate();
  await workbook.inspect({
    kind: "table",
    range: `面试排班!A1:P${lastRow}`,
    include: "values,formulas",
    tableMaxRows: 60,
    tableMaxCols: 16,
    maxChars: 10000,
  });
  const errors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
    options: { useRegex: true, maxResults: 300 },
    summary: "final formula error scan",
  });
  const preview = await workbook.render({
    sheetName: "面试排班",
    range: `A1:P${lastRow}`,
    scale: 1.1,
    format: "png",
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (previewPath) {
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
  }
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
  return { lastRow, formulaScan: errors.ndjson };
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const applicantsPath = path.resolve(args.applicants ?? path.join(projectRoot, "data", "applicants.csv"));
  const slotsPath = path.resolve(args.slots ?? path.join(projectRoot, "data", "slots.csv"));
  const interviewersPath = path.resolve(args.interviewers ?? path.join(projectRoot, "data", "interviewers.csv"));
  const configPath = path.resolve(args.config ?? path.join(projectRoot, "config", "schedule.json"));
  const canonicalOutputPath = path.resolve(path.join(projectRoot, "outputs", "2026_interview_schedule.xlsx"));
  const outputPath = path.resolve(args.output ?? canonicalOutputPath);
  const previewPath = path.resolve(args.preview ?? path.join(projectRoot, "outputs", "2026_interview_schedule_preview.png"));
  const interviewerSourcePath = path.resolve(args["interviewer-source"] ?? canonicalOutputPath);
  const temporaryXlsx = `${outputPath}.tmp-${process.pid}.xlsx`;
  const temporaryPreview = `${previewPath}.tmp-${process.pid}.png`;
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const applicantCsv = parseCsv(await fs.readFile(applicantsPath, "utf8"));
  const slotCsv = parseCsv(await fs.readFile(slotsPath, "utf8"));
  const applicants = applicantCsv.rows.map(normalizeApplicantRow);
  const slots = slotCsv.rows.map(normalizeSlotRow).sort((left, right) => left.display_order - right.display_order);
  const interviewerState = await loadLatestInterviewers({
    interviewersPath,
    sourcePath: interviewerSourcePath,
    slots,
    config,
  });
  const interviewers = interviewerState.interviewers.map(normalizeInterviewerRow);
  const validation = validateSchedule(applicants, slots, config);
  const interviewerValidation = validateInterviewers(interviewers, slots, config);
  const errors = [...validation.errors, ...interviewerValidation.errors];
  if (errors.length) throw new Error(errors.join("\n"));
  const result = await writeScheduleWorkbook({
    applicants,
    interviewers,
    slots,
    config,
    outputPath: temporaryXlsx,
    previewPath: temporaryPreview,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(temporaryXlsx, outputPath);
  await fs.unlink(temporaryXlsx);
  await fs.rm(`${temporaryXlsx}.inspect.ndjson`, { force: true });
  await fs.mkdir(path.dirname(previewPath), { recursive: true });
  await fs.copyFile(temporaryPreview, previewPath);
  await fs.unlink(temporaryPreview);
  const temporaryCsv = `${interviewersPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryCsv, stringifyCsv(INTERVIEWER_HEADERS, interviewers), "utf8");
  await fs.copyFile(temporaryCsv, interviewersPath);
  await fs.unlink(temporaryCsv);
  console.log(
    JSON.stringify({
      outputPath,
      previewPath,
      lastRow: result.lastRow,
      interviewers: interviewerState.summary,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
