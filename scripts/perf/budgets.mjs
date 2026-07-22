export const BUDGETS = Object.freeze({
  tauriExecutableBytes: { maximum: 8 * 1024 * 1024, unit: "bytes" },
  sidecarBytes: { maximum: 22_036_642, unit: "bytes" },
  combinedExecutableBytes: { maximum: 32 * 1024 * 1024, unit: "bytes" },
  frontendGzipBytes: { maximum: 500 * 1024, unit: "bytes" },
  coldStartP95Ms: { maximum: 1_000, unit: "ms" },
  cachedChatSwitchP95Ms: { maximum: 100, unit: "ms" },
  eventToVisibleRowP95Ms: { maximum: 100, unit: "ms" },
  scrollFrameP95Ms: { maximum: 16.7, unit: "ms" },
  scrollFramesOver33Percent: { maximum: 1, unit: "percent" },
  idleCpuPercent: { maximum: 1, unit: "percent_of_one_core" },
  idleRssBytes: { maximum: 200 * 1024 * 1024, unit: "bytes" },
  chatDomRows: { maximum: 200, unit: "rows" },
  messageDomRows: { maximum: 300, unit: "rows" },
  rosterDomRows: { maximum: 100, unit: "rows" },
  rosterAvatarElements: { maximum: 100, unit: "elements" },
});

export function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

export function evaluateBudgets(measurements) {
  return Object.fromEntries(Object.entries(BUDGETS).map(([name, budget]) => {
    const value = measurements[name] ?? null;
    return [name, {
      value,
      maximum: budget.maximum,
      unit: budget.unit,
      passed: Number.isFinite(value) ? value <= budget.maximum : false,
    }];
  }));
}

export function rendererMeasurements(runs) {
  const flat = (key) => runs.flatMap((run) => run[key]);
  const frames = flat("scrollFrameMs");
  return {
    coldStartP95Ms: roundedPercentile(runs.map((run) => run.coldStartToUsableMs), 95),
    cachedChatSwitchP95Ms: roundedPercentile(flat("cachedChatSwitchMs"), 95),
    eventToVisibleRowP95Ms: roundedPercentile(flat("eventToVisibleRowMs"), 95),
    scrollFrameP95Ms: roundedPercentile(frames, 95),
    scrollFramesOver33Percent: frames.length
      ? round((frames.filter((value) => value > 33.3).length / frames.length) * 100)
      : null,
    chatDomRows: Math.max(...runs.map((run) => run.dom.chatRows)),
    messageDomRows: Math.max(...runs.map((run) => run.dom.messageRows)),
    rosterDomRows: Math.max(...runs.map((run) => run.dom.rosterRows)),
    rosterAvatarElements: Math.max(...runs.map((run) => run.dom.rosterAvatarElements)),
  };
}

function roundedPercentile(values, percentileValue) {
  const value = percentile(values, percentileValue);
  return value === null ? null : round(value);
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}
