export const INTERVIEWER_HEADERS = ["slot_id", "department", "interviewers"];

function text(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function compactText(value) {
  return text(value).replace(/\s+/g, "");
}

function keyOf(row) {
  return `${row.slot_id}\u0000${row.department}`;
}

export function normalizeInterviewerRow(row) {
  return {
    slot_id: text(row.slot_id),
    department: text(row.department),
    interviewers: text(row.interviewers),
  };
}

export function compareInterviewerSnapshots(existingRows, latestRows) {
  const existing = new Map(existingRows.map((row) => [keyOf(normalizeInterviewerRow(row)), normalizeInterviewerRow(row)]));
  const latest = new Map(latestRows.map((row) => [keyOf(normalizeInterviewerRow(row)), normalizeInterviewerRow(row)]));
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const [key, row] of latest) {
    const previous = existing.get(key);
    if (!previous) added += 1;
    else if (previous.interviewers !== row.interviewers) updated += 1;
  }
  for (const key of existing.keys()) {
    if (!latest.has(key)) removed += 1;
  }

  return { added, updated, removed };
}

export function validateInterviewers(inputRows, slots, config) {
  const errors = [];
  const slotIds = new Set(slots.map((slot) => slot.slot_id));
  const departments = new Set(config.departments ?? []);
  const seen = new Set();

  for (const source of inputRows) {
    const row = normalizeInterviewerRow(source);
    if (!row.slot_id) errors.push("Interviewer row has an empty slot_id");
    else if (!slotIds.has(row.slot_id)) errors.push(`Unknown interviewer slot ${row.slot_id}`);
    if (!row.department) errors.push(`Interviewer row ${row.slot_id || "(unknown)"} has an empty department`);
    else if (!departments.has(row.department)) errors.push(`Unknown interviewer department ${row.department}`);
    if (!row.interviewers) errors.push(`Interviewer row ${row.slot_id || "(unknown)"}/${row.department || "(unknown)"} is blank`);
    const key = keyOf(row);
    if (seen.has(key)) errors.push(`Duplicate interviewer assignment ${row.slot_id}/${row.department}`);
    seen.add(key);
  }

  return { errors };
}

export function extractInterviewersFromValues(values, slots, config) {
  const errors = [];
  const departments = config.departments ?? [];
  const slotByTime = new Map(
    slots.map((slot) => [`${slot.date}\u0000${slot.start}\u0000${slot.end}`, slot]),
  );
  const slotOrder = new Map(slots.map((slot) => [slot.slot_id, slot.display_order]));
  const departmentOrder = new Map(departments.map((department, index) => [department, index]));
  const seenSlots = new Set();
  const assignments = [];
  let insideSchedule = false;
  let currentDate = "";
  let headerCount = 0;

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] ?? [];
    const first = compactText(row[0]);
    const second = compactText(row[1]);

    if (first === "日期" && second === "时间") {
      headerCount += 1;
      insideSchedule = true;
      currentDate = "";
      const actualDepartments = departments.map((_, index) => compactText(row[index + 2]));
      const expectedDepartments = departments.map(compactText);
      if (actualDepartments.join("|") !== expectedDepartments.join("|")) {
        errors.push(`第 ${rowIndex + 1} 行面试官部门栏与配置不一致`);
      }
      continue;
    }
    if (!insideSchedule) continue;

    const dateMatch = text(row[0]).match(/^(\d{1,2})月(\d{1,2})日$/);
    if (dateMatch) {
      currentDate = `${config.year}-${String(Number(dateMatch[1])).padStart(2, "0")}-${String(Number(dateMatch[2])).padStart(2, "0")}`;
    }

    const timeMatch = text(row[1]).match(/^(\d{1,2}:\d{2})\s*[-–—~～]\s*(\d{1,2}:\d{2})$/);
    if (!timeMatch) continue;
    if (!currentDate) {
      errors.push(`第 ${rowIndex + 1} 行时间缺少对应日期`);
      continue;
    }

    const slot = slotByTime.get(`${currentDate}\u0000${timeMatch[1]}\u0000${timeMatch[2]}`);
    if (!slot) {
      errors.push(`第 ${rowIndex + 1} 行不是已配置场次：${currentDate} ${timeMatch[1]}-${timeMatch[2]}`);
      continue;
    }
    if (seenSlots.has(slot.slot_id)) {
      errors.push(`排班表重复出现场次 ${slot.slot_id}`);
      continue;
    }
    seenSlots.add(slot.slot_id);

    for (let index = 0; index < departments.length; index += 1) {
      const interviewers = text(row[index + 2]);
      if (!interviewers) continue;
      assignments.push({
        slot_id: slot.slot_id,
        department: departments[index],
        interviewers,
      });
    }
  }

  if (headerCount === 0) errors.push("排班表中没有找到日期、时间和面试官部门表头");
  const missingSlots = slots.filter((slot) => !seenSlots.has(slot.slot_id)).map((slot) => slot.slot_id);
  if (missingSlots.length) errors.push(`排班表缺少已配置场次：${missingSlots.join("、")}`);
  if (errors.length) throw new Error(errors.join("\n"));

  return assignments.sort((left, right) => {
    const slotDelta = (slotOrder.get(left.slot_id) ?? 0) - (slotOrder.get(right.slot_id) ?? 0);
    if (slotDelta !== 0) return slotDelta;
    return (departmentOrder.get(left.department) ?? 0) - (departmentOrder.get(right.department) ?? 0);
  });
}
