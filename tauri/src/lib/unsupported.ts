export interface PollPresentation {
  title: string;
  options: string[];
  results: boolean;
}

/** Decode the stable human-readable poll fallback emitted by the backend. */
export function parsePollFallback(value: string): PollPresentation {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.shift() ?? "Poll";
  const results = /^📊\s*Poll results\b/i.test(heading);
  const title = heading.replace(/^📊\s*Poll(?: results)?\s*:?\s*/i, "").trim() || "Poll";
  const options = lines
    .map((line) => line.replace(/^[•●○]\s*/, "").trim())
    .filter(Boolean);
  return { title, options, results };
}
