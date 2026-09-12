const DEFAULT_PERIOD_LABELS = {
  上午: "morning",
  下午: "afternoon",
  晚上: "evening",
};

function normalizeAvailabilityOption(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[‐‑‒–—―−﹘﹣－~～]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeClock(value) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clockMinutes(value) {
  const normalized = normalizeClock(value);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

function availabilityLookup(slots, config) {
  const lookup = new Map();
  for (const slot of slots) {
    const [, year, month, day] = slot.date.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? [];
    if (!month) continue;
    if (Number.isInteger(Number(config.year)) && Number(year) !== Number(config.year)) continue;
    const start = normalizeClock(slot.start);
    const end = normalizeClock(slot.end);
    if (!start || !end) continue;
    lookup.set(`${Number(month)}-${Number(day)}-${start}-${end}`, slot.slot_id);
  }
  return lookup;
}

function configuredPeriodLabels(config) {
  return new Map(
    Object.entries({ ...DEFAULT_PERIOD_LABELS, ...(config.availabilityPeriodLabels ?? {}) }).map(
      ([label, period]) => [normalizeAvailabilityOption(label).replace(/\s+/g, ""), period],
    ),
  );
}

function configuredSpecialOptions(config) {
  return new Map(
    Object.entries(config.specialAvailabilityOptions ?? {}).map(([option, value]) => [
      normalizeAvailabilityOption(option),
      value,
    ]),
  );
}

function slotsInWindow({ month, day, period, start, end }, slots, config) {
  const year = Number(config.year);
  if (!Number.isInteger(year)) return [];
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const startMinutes = clockMinutes(start);
  const endMinutes = clockMinutes(end);
  if (startMinutes == null || endMinutes == null || startMinutes >= endMinutes) return [];

  const matching = slots
    .filter((slot) => slot.date === date && slot.period === period)
    .map((slot) => ({
      slot,
      startMinutes: clockMinutes(slot.start),
      endMinutes: clockMinutes(slot.end),
    }))
    .filter(
      (item) =>
        item.startMinutes != null &&
        item.endMinutes != null &&
        item.startMinutes >= startMinutes &&
        item.endMinutes <= endMinutes,
    )
    .sort((left, right) => left.slot.display_order - right.slot.display_order);

  if (
    !matching.length ||
    matching[0].startMinutes !== startMinutes ||
    matching.at(-1).endMinutes !== endMinutes
  ) {
    return [];
  }
  return matching.map((item) => item.slot.slot_id);
}

export function parseAvailability(value, slots, config) {
  const lookup = availabilityLookup(slots, config);
  const displayOrder = new Map(slots.map((slot) => [slot.slot_id, slot.display_order]));
  const availableSlots = [];
  const unknownOptions = [];
  let onlineOnlySelected = false;
  const options = String(value ?? "")
    .split(/[┋\r\n；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const periodLabels = configuredPeriodLabels(config);
  const specialOptions = configuredSpecialOptions(config);

  for (const rawOption of options) {
    const option = normalizeAvailabilityOption(rawOption);
    if (specialOptions.get(option) === "online_only") {
      onlineOnlySelected = true;
      continue;
    }

    const exactMatch = option.match(
      /^(\d{1,2})月(\d{1,2})日?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/,
    );
    if (exactMatch) {
      const start = normalizeClock(exactMatch[3]);
      const end = normalizeClock(exactMatch[4]);
      const slotId =
        start && end
          ? lookup.get(`${Number(exactMatch[1])}-${Number(exactMatch[2])}-${start}-${end}`)
          : null;
      if (slotId) {
        availableSlots.push(slotId);
        continue;
      }
      unknownOptions.push(rawOption);
      continue;
    }

    const windowMatch = option.match(
      /^(\d{1,2})月(\d{1,2})日?\s*([^\d():]+?)\s*(?:\(\s*)?(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(?:之间)?\s*\)?$/,
    );
    if (!windowMatch) {
      unknownOptions.push(rawOption);
      continue;
    }
    const period = periodLabels.get(windowMatch[3].replace(/\s+/g, ""));
    const start = normalizeClock(windowMatch[4]);
    const end = normalizeClock(windowMatch[5]);
    const windowSlots =
      period && start && end
        ? slotsInWindow(
            {
              month: Number(windowMatch[1]),
              day: Number(windowMatch[2]),
              period,
              start,
              end,
            },
            slots,
            config,
          )
        : [];
    if (!windowSlots.length) {
      unknownOptions.push(rawOption);
      continue;
    }
    availableSlots.push(...windowSlots);
  }

  return {
    availableSlots: [...new Set(availableSlots)].sort(
      (left, right) => (displayOrder.get(left) ?? Infinity) - (displayOrder.get(right) ?? Infinity),
    ),
    onlineOnlySelected,
    unknownOptions,
  };
}
