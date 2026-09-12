const APPLICANT_HEADERS = [
  "student_id",
  "name",
  "available_slots",
  "assigned_slot",
  "seat_no",
  "status",
];

const SLOT_HEADERS = ["slot_id", "date", "start", "end", "period", "display_order"];

export { APPLICANT_HEADERS, SLOT_HEADERS };

export function normalizeApplicantRow(row) {
  return {
    student_id: String(row.student_id ?? "").trim(),
    name: String(row.name ?? "").trim(),
    available_slots: String(row.available_slots ?? "")
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean),
    assigned_slot: String(row.assigned_slot ?? "").trim(),
    seat_no: String(row.seat_no ?? "").trim(),
    status: String(row.status ?? "unassigned").trim() || "unassigned",
  };
}

export function normalizeSlotRow(row) {
  return {
    slot_id: String(row.slot_id ?? "").trim(),
    date: String(row.date ?? "").trim(),
    start: String(row.start ?? "").trim(),
    end: String(row.end ?? "").trim(),
    period: String(row.period ?? "").trim(),
    display_order: Number(row.display_order),
  };
}

function compareStrings(left, right) {
  return String(left).localeCompare(String(right), "zh-CN");
}

function lexicographicCompare(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function groupPenalty(size, target) {
  if (size <= 0) return 999;
  if (size === 1) return 300;
  if (size === 2) return 200;
  if (size === target) return 0;
  if (size === target + 1) return 1;
  if (size === target - 1) return 2;
  return 3;
}

function bestPartition(total, minimum, maximum, target, memo = new Map()) {
  if (total === 0) return { groups: 0, deviation: 0, sizes: [] };
  if (total < minimum) return null;
  if (memo.has(total)) return memo.get(total);
  let best = null;
  for (let size = minimum; size <= maximum && size <= total; size += 1) {
    const tail = bestPartition(total - size, minimum, maximum, target, memo);
    if (!tail) continue;
    const candidate = {
      groups: tail.groups + 1,
      deviation: tail.deviation + Math.abs(size - target),
      sizes: [size, ...tail.sizes],
    };
    if (
      !best ||
      lexicographicCompare(
        [candidate.groups, candidate.deviation, Math.abs(size - target), -size],
        [best.groups, best.deviation, Math.abs(best.sizes[0] - target), -best.sizes[0]],
      ) < 0
    ) {
      best = candidate;
    }
  }
  memo.set(total, best);
  return best;
}

export function chooseBatchSize(total, config) {
  const maximum = config.maxAutoGroupSize;
  const minimum = config.smallGroupThreshold;
  const target = config.targetGroupSize;
  if (total <= maximum) return total;
  const partition = bestPartition(total, minimum, maximum, target);
  return partition?.sizes[0] ?? maximum;
}

function slotPreference(slot, activeSlotIds, slotById) {
  const morningPenalty = slot.period === "morning" ? 1 : 0;
  const activeSameDate = [...activeSlotIds]
    .map((slotId) => slotById.get(slotId))
    .filter((item) => item?.date === slot.date);
  const compactnessPenalty = activeSameDate.length
    ? Math.min(...activeSameDate.map((item) => Math.abs(item.display_order - slot.display_order)))
    : 999;
  return [morningPenalty, Number(slot.date.replaceAll("-", "")), compactnessPenalty, slot.display_order];
}

function applicantFlexibility(applicant, activeSlotIds, slotById) {
  return applicant.available_slots.filter(
    (slotId) => slotById.has(slotId) && !activeSlotIds.has(slotId),
  ).length;
}

function assignToGroup(applicant, slotId, groups) {
  applicant.assigned_slot = slotId;
  applicant.status = "scheduled";
  if (!groups.has(slotId)) groups.set(slotId, []);
  groups.get(slotId).push(applicant);
}

function removeFromGroup(applicant, groups) {
  const current = groups.get(applicant.assigned_slot) ?? [];
  groups.set(
    applicant.assigned_slot,
    current.filter((item) => item !== applicant),
  );
  applicant.assigned_slot = "";
  applicant.seat_no = "";
  applicant.status = "unassigned";
}

function tryAbsorbSmallGroup(slotId, groups, config, slotById) {
  const members = [...(groups.get(slotId) ?? [])];
  if (members.length === 0 || members.length >= config.smallGroupThreshold) return false;
  const otherGroups = [...groups.entries()]
    .filter(([otherId, group]) => otherId !== slotId && group.length < config.maxAutoGroupSize)
    .sort(([leftId, left], [rightId, right]) => {
      const fillDelta = right.length - left.length;
      if (fillDelta !== 0) return fillDelta;
      return lexicographicCompare(
        slotPreference(slotById.get(leftId), new Set(groups.keys()), slotById),
        slotPreference(slotById.get(rightId), new Set(groups.keys()), slotById),
      );
    });

  const planned = [];
  const capacities = new Map(otherGroups.map(([id, group]) => [id, config.maxAutoGroupSize - group.length]));
  const orderedMembers = [...members].sort(
    (left, right) => left.available_slots.length - right.available_slots.length || compareStrings(left.student_id, right.student_id),
  );

  function place(index) {
    if (index === orderedMembers.length) return true;
    const member = orderedMembers[index];
    for (const [candidateSlotId] of otherGroups) {
      if (!member.available_slots.includes(candidateSlotId) || capacities.get(candidateSlotId) <= 0) continue;
      capacities.set(candidateSlotId, capacities.get(candidateSlotId) - 1);
      planned.push([member, candidateSlotId]);
      if (place(index + 1)) return true;
      planned.pop();
      capacities.set(candidateSlotId, capacities.get(candidateSlotId) + 1);
    }
    return false;
  }

  if (!place(0)) return false;
  for (const [member, destination] of planned) {
    removeFromGroup(member, groups);
    assignToGroup(member, destination, groups);
  }
  groups.delete(slotId);
  return true;
}

function tryGrowSmallGroup(slotId, groups, config) {
  const group = groups.get(slotId) ?? [];
  if (group.length === 0 || group.length >= config.smallGroupThreshold) return false;
  let changed = false;
  while (group.length < config.smallGroupThreshold) {
    const donors = [...groups.entries()]
      .filter(([otherId, members]) => otherId !== slotId && members.length > config.smallGroupThreshold)
      .flatMap(([otherId, members]) =>
        members
          .filter((member) => member.available_slots.includes(slotId))
          .map((member) => ({ member, otherId, donorSize: members.length })),
      )
      .sort((left, right) => {
        const existingDelta = Number(left.member._wasExisting) - Number(right.member._wasExisting);
        if (existingDelta !== 0) return existingDelta;
        const donorDelta = right.donorSize - left.donorSize;
        if (donorDelta !== 0) return donorDelta;
        return compareStrings(left.member.student_id, right.member.student_id);
      });
    const donor = donors[0];
    if (!donor) break;
    removeFromGroup(donor.member, groups);
    assignToGroup(donor.member, slotId, groups);
    changed = true;
  }
  return changed;
}

function assignSeatNumbers(groups, maximum) {
  for (const members of groups.values()) {
    const used = new Set();
    for (const member of members) {
      const previousSeat = Number(member._previousSeat);
      if (
        member._previousAssignment === member.assigned_slot &&
        Number.isInteger(previousSeat) &&
        previousSeat >= 1 &&
        previousSeat <= maximum &&
        !used.has(previousSeat)
      ) {
        member.seat_no = String(previousSeat);
        used.add(previousSeat);
      } else {
        member.seat_no = "";
      }
    }
    for (const member of members.sort((left, right) => compareStrings(left.student_id, right.student_id))) {
      if (member.seat_no) continue;
      let seat = 1;
      while (used.has(seat) && seat <= maximum) seat += 1;
      member.seat_no = String(seat);
      used.add(seat);
    }
  }
}

export function scheduleApplicants(inputApplicants, slots, config) {
  const slotById = new Map(slots.map((slot) => [slot.slot_id, slot]));
  const applicants = inputApplicants.map((source) => ({
    ...source,
    available_slots: [...new Set(source.available_slots)].filter((slotId) => slotById.has(slotId)),
    _previousAssignment: source.assigned_slot,
    _previousSeat: source.seat_no,
    _wasExisting: Boolean(source._wasExisting),
  }));
  const groups = new Map();
  const occupiedSeats = new Set();

  for (const applicant of applicants) {
    if (applicant.status === "withdrawn") {
      applicant.assigned_slot = "";
      applicant.seat_no = "";
      continue;
    }
    const assignmentIsValid =
      applicant.assigned_slot &&
      applicant.available_slots.includes(applicant.assigned_slot) &&
      slotById.has(applicant.assigned_slot);
    if (!assignmentIsValid) {
      applicant.assigned_slot = "";
      applicant.seat_no = "";
      applicant.status = applicant.available_slots.length ? "unassigned" : applicant.status === "online_only" ? "online_only" : "unassigned";
      continue;
    }
    const seatKey = `${applicant.assigned_slot}:${applicant.seat_no}`;
    if (applicant.seat_no && occupiedSeats.has(seatKey)) {
      throw new Error(`Duplicate seat assignment detected at ${seatKey}`);
    }
    if (applicant.seat_no) occupiedSeats.add(seatKey);
    assignToGroup(applicant, applicant.assigned_slot, groups);
  }

  for (const [slotId, members] of groups) {
    if (members.length > config.maxAutoGroupSize) {
      throw new Error(`Existing group ${slotId} exceeds automatic maximum ${config.maxAutoGroupSize}`);
    }
  }

  const activeSlotIds = new Set(groups.keys());
  let unassigned = applicants.filter(
    (applicant) => applicant.status !== "withdrawn" && applicant.available_slots.length > 0 && !applicant.assigned_slot,
  );

  // Fill already used groups up to the five-person target before opening new slots.
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    unassigned.sort(
      (left, right) => left.available_slots.length - right.available_slots.length || compareStrings(left.student_id, right.student_id),
    );
    for (const applicant of [...unassigned]) {
      const destinations = applicant.available_slots
        .filter((slotId) => activeSlotIds.has(slotId) && (groups.get(slotId)?.length ?? 0) < config.targetGroupSize)
        .sort((leftId, rightId) => {
          const leftSize = groups.get(leftId)?.length ?? 0;
          const rightSize = groups.get(rightId)?.length ?? 0;
          if (leftSize !== rightSize) return rightSize - leftSize;
          return lexicographicCompare(
            slotPreference(slotById.get(leftId), activeSlotIds, slotById),
            slotPreference(slotById.get(rightId), activeSlotIds, slotById),
          );
        });
      if (!destinations.length) continue;
      assignToGroup(applicant, destinations[0], groups);
      unassigned = unassigned.filter((item) => item !== applicant);
      madeProgress = true;
    }
  }

  while (unassigned.length > 0) {
    // Anchor each new group with the applicant who has the fewest unopened
    // alternatives, then use more flexible applicants to complete the batch.
    const anchorCandidate = unassigned
      .map((applicant) => ({
        applicant,
        closedSlotIds: applicant.available_slots.filter(
          (slotId) => slotById.has(slotId) && !activeSlotIds.has(slotId),
        ),
      }))
      .filter((candidate) => candidate.closedSlotIds.length > 0)
      .sort((left, right) => {
        const flexibilityDelta = left.closedSlotIds.length - right.closedSlotIds.length;
        if (flexibilityDelta !== 0) return flexibilityDelta;
        return compareStrings(left.applicant.student_id, right.applicant.student_id);
      })[0];

    if (!anchorCandidate) break;
    const closedCandidates = anchorCandidate.closedSlotIds
      .map((slotId) => slotById.get(slotId))
      .map((slot) => {
        const eligible = unassigned.filter((applicant) => applicant.available_slots.includes(slot.slot_id));
        const batchSize = chooseBatchSize(eligible.length, config);
        return { slot, eligible, batchSize };
      })
      .filter((candidate) => candidate.eligible.length > 0)
      .sort((left, right) => {
        const groupDelta = groupPenalty(left.batchSize, config.targetGroupSize) - groupPenalty(right.batchSize, config.targetGroupSize);
        if (groupDelta !== 0) return groupDelta;
        const slotDelta = lexicographicCompare(
          slotPreference(left.slot, activeSlotIds, slotById),
          slotPreference(right.slot, activeSlotIds, slotById),
        );
        if (slotDelta !== 0) return slotDelta;
        return right.eligible.length - left.eligible.length;
      });

    if (closedCandidates.length === 0) break;
    const selected = closedCandidates[0];
    activeSlotIds.add(selected.slot.slot_id);
    const batch = [
      anchorCandidate.applicant,
      ...selected.eligible
        .filter((applicant) => applicant !== anchorCandidate.applicant)
        .sort((left, right) => {
          const flexibilityDelta =
            applicantFlexibility(left, activeSlotIds, slotById) -
            applicantFlexibility(right, activeSlotIds, slotById);
          return flexibilityDelta || compareStrings(left.student_id, right.student_id);
        }),
    ].slice(0, selected.batchSize);
    for (const applicant of batch) {
      assignToGroup(applicant, selected.slot.slot_id, groups);
      unassigned = unassigned.filter((item) => item !== applicant);
    }
  }

  // A sixth seat is preferable to opening an unavoidable one-person group.
  for (const applicant of [...unassigned]) {
    const destinations = applicant.available_slots
      .filter((slotId) => activeSlotIds.has(slotId) && (groups.get(slotId)?.length ?? 0) < config.maxAutoGroupSize)
      .sort((leftId, rightId) => {
        const leftSize = groups.get(leftId)?.length ?? 0;
        const rightSize = groups.get(rightId)?.length ?? 0;
        if (leftSize !== rightSize) return rightSize - leftSize;
        return lexicographicCompare(
          slotPreference(slotById.get(leftId), activeSlotIds, slotById),
          slotPreference(slotById.get(rightId), activeSlotIds, slotById),
        );
      });
    if (!destinations.length) continue;
    assignToGroup(applicant, destinations[0], groups);
    unassigned = unassigned.filter((item) => item !== applicant);
  }

  // Try to close or grow one-/two-person groups without creating another small group.
  let rebalanced = true;
  while (rebalanced) {
    rebalanced = false;
    const smallIds = [...groups.entries()]
      .filter(([, members]) => members.length > 0 && members.length < config.smallGroupThreshold)
      .map(([slotId]) => slotId);
    for (const slotId of smallIds) {
      if (tryAbsorbSmallGroup(slotId, groups, config, slotById)) {
        activeSlotIds.delete(slotId);
        rebalanced = true;
        continue;
      }
      if (tryGrowSmallGroup(slotId, groups, config)) rebalanced = true;
    }
  }

  for (const applicant of unassigned) {
    applicant.assigned_slot = "";
    applicant.seat_no = "";
    applicant.status = "unassigned";
  }
  assignSeatNumbers(groups, config.maxAutoGroupSize);

  const movedApplicants = applicants
    .filter(
      (applicant) => applicant._previousAssignment && applicant._previousAssignment !== applicant.assigned_slot,
    )
    .map((applicant) => ({
      student_id: applicant.student_id,
      name: applicant.name,
      from: applicant._previousAssignment,
      to: applicant.assigned_slot,
    }));
  const smallGroups = [...groups.entries()]
    .filter(([, members]) => members.length > 0 && members.length < config.smallGroupThreshold)
    .map(([slot_id, members]) => ({ slot_id, count: members.length }));
  const sixPersonGroups = [...groups.entries()]
    .filter(([, members]) => members.length === config.maxAutoGroupSize)
    .map(([slot_id, members]) => ({ slot_id, count: members.length }));

  const output = applicants
    .map((applicant) => ({
      student_id: applicant.student_id,
      name: applicant.name,
      available_slots: applicant.available_slots.join("|"),
      assigned_slot: applicant.assigned_slot,
      seat_no: applicant.seat_no,
      status: applicant.status,
    }))
    .sort((left, right) => compareStrings(left.student_id, right.student_id));

  return {
    applicants: output,
    summary: {
      scheduled: output.filter((applicant) => applicant.status === "scheduled").length,
      unassigned: output.filter((applicant) => applicant.status === "unassigned").length,
      onlineOnly: output.filter((applicant) => applicant.status === "online_only").length,
      movedApplicants,
      smallGroups,
      sixPersonGroups,
    },
  };
}

export function validateSchedule(applicants, slots, config) {
  const errors = [];
  const warnings = [];
  const slotIds = new Set(slots.map((slot) => slot.slot_id));
  const studentIds = new Set();
  const seatKeys = new Set();
  const groupCounts = new Map();

  for (const slot of slots) {
    if (!slot.slot_id || !slot.date || !slot.start || !slot.end || !Number.isFinite(slot.display_order)) {
      errors.push(`Invalid slot row: ${JSON.stringify(slot)}`);
    }
  }

  for (const applicant of applicants) {
    if (!applicant.student_id) errors.push("Applicant has an empty student_id");
    if (!applicant.name) errors.push(`Applicant ${applicant.student_id || "(unknown)"} has an empty name`);
    if (studentIds.has(applicant.student_id)) errors.push(`Duplicate student_id: ${applicant.student_id}`);
    studentIds.add(applicant.student_id);
    const availability = Array.isArray(applicant.available_slots)
      ? applicant.available_slots
      : String(applicant.available_slots ?? "").split("|").filter(Boolean);
    for (const slotId of availability) {
      if (!slotIds.has(slotId)) errors.push(`Unknown available slot ${slotId} for ${applicant.student_id}`);
    }
    if (applicant.assigned_slot) {
      if (!slotIds.has(applicant.assigned_slot)) errors.push(`Unknown assigned slot ${applicant.assigned_slot}`);
      if (!availability.includes(applicant.assigned_slot)) {
        errors.push(`Assigned slot is outside availability for ${applicant.student_id}`);
      }
      const seat = Number(applicant.seat_no);
      if (!Number.isInteger(seat) || seat < 1 || seat > config.maxAutoGroupSize) {
        errors.push(`Invalid seat number for ${applicant.student_id}`);
      }
      const key = `${applicant.assigned_slot}:${seat}`;
      if (seatKeys.has(key)) errors.push(`Duplicate seat ${key}`);
      seatKeys.add(key);
      groupCounts.set(applicant.assigned_slot, (groupCounts.get(applicant.assigned_slot) ?? 0) + 1);
    } else if (applicant.seat_no) {
      errors.push(`Seat number without assignment for ${applicant.student_id}`);
    }
  }

  for (const [slotId, count] of groupCounts) {
    if (count > config.maxAutoGroupSize) errors.push(`Group ${slotId} has ${count} applicants`);
    if (count < config.smallGroupThreshold) warnings.push(`Small group ${slotId} has ${count} applicants`);
    if (count === config.maxAutoGroupSize) warnings.push(`Six-person group ${slotId}`);
  }
  return { errors, warnings, groupCounts };
}
