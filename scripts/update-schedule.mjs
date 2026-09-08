import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, stringifyCsv } from "./lib/csv.mjs";
import {
  APPLICANT_HEADERS,
  normalizeApplicantRow,
  normalizeSlotRow,
  scheduleApplicants,
  validateSchedule,
} from "./lib/scheduler.mjs";
import { importWorkbookSnapshot } from "./lib/workbook-import.mjs";
import { writeScheduleWorkbook } from "./build-xlsx.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    result[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function renderPeople(items) {
  if (!items.length) return "无";
  return items.map((item) => `${item.name}（${item.student_id}）`).join("、");
}

function buildReport({ inputPath, sourceHash, importSummary, scheduleSummary, validation }) {
  const lines = [
    "# 本次报名表处理结果",
    "",
    `- 来源文件：${path.basename(inputPath)}`,
    `- 文件 SHA-256：${sourceHash}`,
    `- 原始有效行数：${importSummary.sourceRows}`,
    `- 按学号归并后人数：${importSummary.activeResponses}`,
    `- 新增：${importSummary.added.length}`,
    `- 更新：${importSummary.updated.length}`,
    `- 重复提交人员：${importSummary.resubmissions.length}`,
    `- 已排班：${scheduleSummary.scheduled}`,
    `- 未排班：${scheduleSummary.unassigned}`,
    `- 仅选择线上面试：${scheduleSummary.onlineOnly}`,
    "",
    "## 人员变化",
    "",
    `- 新增：${renderPeople(importSummary.added)}`,
    `- 更新：${renderPeople(importSummary.updated)}`,
    `- 重复提交：${renderPeople(importSummary.resubmissions)}`,
    `- 新快照未包含的旧人员：${renderPeople(importSummary.missingFromSnapshot)}`,
    `- 仅选择未配置线上场次：${renderPeople(importSummary.onlineOnly)}`,
    "",
    "## 排班提示",
    "",
  ];
  if (!scheduleSummary.movedApplicants.length) {
    lines.push("- 没有移动已有有效安排。");
  } else {
    for (const item of scheduleSummary.movedApplicants) {
      lines.push(`- ${item.name}（${item.student_id}）：${item.from} → ${item.to || "未安排"}`);
    }
  }
  for (const group of scheduleSummary.smallGroups) {
    lines.push(`- 小组人数偏少：${group.slot_id}，${group.count} 人。`);
  }
  for (const group of scheduleSummary.sixPersonGroups) {
    lines.push(`- 使用六人场次：${group.slot_id}。`);
  }
  if (!scheduleSummary.smallGroups.length && !scheduleSummary.sixPersonGroups.length) {
    lines.push("- 没有 1～2 人场次，也没有六人场次。");
  }
  if (scheduleSummary.unassigned > 0) {
    lines.push(`- 有 ${scheduleSummary.unassigned} 人尚未安排，需要人工关注。`);
  }
  if (validation.warnings.length) {
    lines.push("", "## 校验警告", "", ...validation.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

async function sha256(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function writeFileAtomically(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents, "utf8");
  await fs.copyFile(temporary, filePath);
  await fs.unlink(temporary);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error("必须提供 --input 报名表路径");
  const inputPath = path.resolve(args.input);
  const applicantsPath = path.resolve(args.applicants ?? path.join(projectRoot, "data", "applicants.csv"));
  const slotsPath = path.resolve(args.slots ?? path.join(projectRoot, "data", "slots.csv"));
  const configPath = path.resolve(args.config ?? path.join(projectRoot, "config", "schedule.json"));
  const outputPath = path.resolve(args.output ?? path.join(projectRoot, "outputs", "2026_interview_schedule.xlsx"));
  const previewPath = path.resolve(args.preview ?? path.join(projectRoot, "outputs", "2026_interview_schedule_preview.png"));
  const reportPath = path.resolve(args.report ?? path.join(projectRoot, "reports", "latest-conflicts.md"));
  const temporaryXlsx = `${outputPath}.tmp-${process.pid}.xlsx`;
  const temporaryPreview = `${previewPath}.tmp-${process.pid}.png`;

  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const existingCsv = parseCsv(await fs.readFile(applicantsPath, "utf8"));
  const slotCsv = parseCsv(await fs.readFile(slotsPath, "utf8"));
  const existingApplicants = existingCsv.rows.map(normalizeApplicantRow);
  const slots = slotCsv.rows.map(normalizeSlotRow).sort((left, right) => left.display_order - right.display_order);
  const imported = await importWorkbookSnapshot({
    inputPath,
    slots,
    config,
    existingApplicants,
  });
  const scheduled = scheduleApplicants(imported.applicants, slots, config);
  const normalizedScheduled = scheduled.applicants.map(normalizeApplicantRow);
  const validation = validateSchedule(normalizedScheduled, slots, config);
  if (validation.errors.length) throw new Error(validation.errors.join("\n"));

  await fs.mkdir(path.dirname(temporaryXlsx), { recursive: true });
  await writeScheduleWorkbook({
    applicants: normalizedScheduled,
    slots,
    config,
    outputPath: temporaryXlsx,
    previewPath: temporaryPreview,
  });

  const sourceHash = await sha256(inputPath);
  const report = buildReport({
    inputPath,
    sourceHash,
    importSummary: imported.summary,
    scheduleSummary: scheduled.summary,
    validation,
  });
  const csv = stringifyCsv(APPLICANT_HEADERS, scheduled.applicants);

  await writeFileAtomically(applicantsPath, csv);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(temporaryXlsx, outputPath);
  await fs.unlink(temporaryXlsx);
  await fs.rm(`${temporaryXlsx}.inspect.ndjson`, { force: true });
  await fs.mkdir(path.dirname(previewPath), { recursive: true });
  await fs.copyFile(temporaryPreview, previewPath);
  await fs.unlink(temporaryPreview);
  await writeFileAtomically(reportPath, report);

  console.log(
    JSON.stringify({
      sourceHash,
      sourceRows: imported.summary.sourceRows,
      applicants: scheduled.applicants.length,
      added: imported.summary.added.length,
      updated: imported.summary.updated.length,
      resubmissions: imported.summary.resubmissions.length,
      scheduled: scheduled.summary.scheduled,
      unassigned: scheduled.summary.unassigned,
      onlineOnly: scheduled.summary.onlineOnly,
      smallGroups: scheduled.summary.smallGroups,
      sixPersonGroups: scheduled.summary.sixPersonGroups,
      outputPath,
      previewPath,
      reportPath,
    }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
