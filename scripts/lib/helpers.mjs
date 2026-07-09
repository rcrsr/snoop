/**
 * File I/O and utility helpers
 */

import * as fs from "fs";
import * as readline from "readline";

/**
 * Read a JSONL file and parse each line
 */
export async function readJsonLines(filePath) {
  const lines = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) {
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }
  return lines;
}

/**
 * Format seconds as human-readable duration
 */
export function formatDuration(seconds) {
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }
  return `${seconds}s`;
}

/**
 * Calculate timing info from messages.
 *
 * A turn ends when the hook fires, not when the last message was written. Pass
 * turnEnd (the hook's wall clock) to close the span there. This gives one
 * definition of the end for every turn: a turn that failed before the assistant
 * replied has no span of its own and would otherwise read "unknown", and a turn
 * whose final message never reached disk would otherwise stop at its last
 * tool_result. A message timestamp later than turnEnd still wins, since the
 * hook stamps its clock before waiting for that message to land.
 *
 * Claude Code's own `system/turn_duration` record cannot serve here: it is
 * written after the Stop hook returns, so it never exists for the turn being
 * captured.
 *
 * Returns { start, end, duration, durationFormatted }
 */
export function calculateTiming(messages, turnEnd = null) {
  const timestamps = messages
    .map((m) => m.timestamp)
    .filter((t) => !!t)
    .map((t) => new Date(t).getTime())
    .sort((a, b) => a - b);

  const end = turnEnd ? new Date(turnEnd).getTime() : NaN;
  if (timestamps.length >= 1 && Number.isFinite(end) && end > timestamps[timestamps.length - 1]) {
    timestamps.push(end);
  }

  if (timestamps.length < 2) {
    return {
      start: null,
      end: null,
      duration: 0,
      durationFormatted: "unknown",
    };
  }

  try {
    const start = new Date(timestamps[0]).toISOString();
    const end = new Date(timestamps[timestamps.length - 1]).toISOString();
    const seconds = Math.floor((timestamps[timestamps.length - 1] - timestamps[0]) / 1000);
    return {
      start,
      end,
      duration: seconds,
      durationFormatted: formatDuration(seconds),
    };
  } catch {
    return {
      start: null,
      end: null,
      duration: 0,
      durationFormatted: "unknown",
    };
  }
}
