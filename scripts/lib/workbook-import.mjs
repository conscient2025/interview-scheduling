import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

function normalizedHeader(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function findHeader(headers, patterns, label) {
  const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
  if (index < 0) throw new Error(`报名表缺少字段：${label}`);
  return index;
}

function parseSubmissionTime(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return Number.NEGATIVE_INFINITY;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  );
}

function availabilityLookup(slots) {
  const lookup = new Map();
  for (const slot of slots) {
    const [, month, day] = slot.date.match(/^\d{4}-(\d{2})-(\d{2})$/) ?? [];
    if (!month) continue;
    lookup.set(`${Number(month)}-${Number(day)}-${slot.start}-${slot.end}`, slot.slot_id);
  }
  return lookup;
}

function parseAvailability(value, slots, config) {
  const lookup = availabilityLookup(slots);
  const exactSlots = [];
  const unknownOptions = [];
  let onlineOnlySelected = false;
  const options = String(value ?? "")
    .split(/[┋\r\n；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const option of options) {
    if (config.specialAvailabilityOptions?.[option] === "online_only") {
      onlineOnlySelected = true;
      continue;
    }
    const match = option.match(/^(\d{1,2})月(\d{1,2})日?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!match) {
      unknownOptions.push(option);
      continue;
    }
    const slotId = lookup.get(`${Number(match[1])}-${Number(match[2])}-${match[3]}-${match[4]}`);
    if (!slotId) {
      unknownOptions.push(option);
      continue;
    }
    exactSlots.push(slotId);
  }

  return {
    exactSlots: [...new Set(exactSlots)],
    onlineOnlySelected,
    unknownOptions,
  };
}

function sameArray(left, right) {
  return [...left].sort().join("|") === [...right].sort().join("|");
}

export async function importWorkbookSnapshot({ inputPath, slots, config, existingApplicants }) {
  const blob = await FileBlob.load(inputPath);
  const workbook = await SpreadsheetFile.importXlsx(blob);
  const sheet = workbook.worksheets.getItemAt(0);
  const usedRange = sheet.getUsedRange();
  const values = usedRange?.values ?? [];
  if (values.length < 2) throw new Error("报名表没有数据行");

  const headers = values[0].map(normalizedHeader);
  const indexes = {
    sequence: findHeader(headers, [/^序号$/], "序号"),
    submittedAt: findHeader(headers, [/^提交答卷时间$/], "提交答卷时间"),
    name: findHeader(headers, [/^1[、.．]姓名/], "姓名"),
    studentId: findHeader(headers, [/^3[、.．]学号/], "学号"),
    availability: findHeader(headers, [/^9[、.．]请选择你的面试时间/], "面试时间"),
  };

  const errors = [];
  const sourceRows = [];
  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] ?? [];
    if (row.every((value) => value == null || String(value).trim() === "")) continue;
    const studentId = String(row[indexes.studentId] ?? "").trim();
    const name = String(row[indexes.name] ?? "").trim();
    if (!studentId || !name) {
      errors.push(`第 ${rowIndex + 1} 行缺少${!studentId ? "学号" : "姓名"}`);
      continue;
    }
    const parsedAvailability = parseAvailability(row[indexes.availability], slots, config);
    if (parsedAvailability.unknownOptions.length) {
      errors.push(
        `第 ${rowIndex + 1} 行存在未知面试选项：${parsedAvailability.unknownOptions.join("；")}`,
      );
    }
    sourceRows.push({
      student_id: studentId,
      name,
      sequence: String(row[indexes.sequence] ?? "").trim(),
      submittedAt: parseSubmissionTime(row[indexes.submittedAt]),
      rowIndex,
      availability: parsedAvailability.exactSlots,
      onlineOnlySelected: parsedAvailability.onlineOnlySelected,
    });
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const byStudent = new Map();
  for (const response of sourceRows) {
    if (!byStudent.has(response.student_id)) byStudent.set(response.student_id, []);
    byStudent.get(response.student_id).push(response);
  }

  const latestResponses = [];
  const resubmissions = [];
  for (const [studentId, responses] of byStudent) {
    responses.sort((left, right) => {
      const timestampDelta = right.submittedAt - left.submittedAt;
      if (timestampDelta !== 0) return timestampDelta;
      const sequenceDelta = Number(right.sequence) - Number(left.sequence);
      if (Number.isFinite(sequenceDelta) && sequenceDelta !== 0) return sequenceDelta;
      return right.rowIndex - left.rowIndex;
    });
    latestResponses.push(responses[0]);
    if (responses.length > 1) {
      resubmissions.push({ student_id: studentId, name: responses[0].name, count: responses.length });
    }
  }

  const existingByStudent = new Map(existingApplicants.map((applicant) => [applicant.student_id, applicant]));
  const importedStudents = new Set();
  const applicants = [];
  const added = [];
  const updated = [];
  const onlineOnly = [];

  for (const response of latestResponses) {
    importedStudents.add(response.student_id);
    const existing = existingByStudent.get(response.student_id);
    const status =
      existing?.status === "withdrawn"
        ? "withdrawn"
        : response.availability.length === 0 && response.onlineOnlySelected
          ? "online_only"
          : existing?.status ?? "unassigned";
    const applicant = {
      student_id: response.student_id,
      name: response.name,
      available_slots: response.availability,
      assigned_slot: existing?.assigned_slot ?? "",
      seat_no: existing?.seat_no ?? "",
      status,
      _wasExisting: Boolean(existing),
    };
    applicants.push(applicant);
    if (!existing) {
      added.push({ student_id: applicant.student_id, name: applicant.name });
    } else if (
      existing.name !== applicant.name ||
      !sameArray(existing.available_slots, applicant.available_slots)
    ) {
      updated.push({ student_id: applicant.student_id, name: applicant.name });
    }
    if (status === "online_only") onlineOnly.push({ student_id: applicant.student_id, name: applicant.name });
  }

  const missingFromSnapshot = [];
  for (const existing of existingApplicants) {
    if (importedStudents.has(existing.student_id)) continue;
    applicants.push({ ...existing, available_slots: [...existing.available_slots], _wasExisting: true });
    missingFromSnapshot.push({ student_id: existing.student_id, name: existing.name });
  }

  return {
    applicants,
    summary: {
      sourceRows: sourceRows.length,
      activeResponses: latestResponses.length,
      added,
      updated,
      resubmissions,
      onlineOnly,
      missingFromSnapshot,
    },
  };
}

