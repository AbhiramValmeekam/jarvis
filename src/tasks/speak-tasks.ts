/**
 * Turning a task snapshot into a sentence.
 *
 * Separate from `task-watcher.ts` on purpose: the watcher owns an interval
 * timer, and the local-intent executors — which run on the latency-critical path
 * and are meant to be pure — have no business importing something that can
 * schedule work. This module is all string building and no state.
 *
 * The rule every function here follows: **say the caveat first.** A user who
 * hears four jobs read out and a warning at the end has already stopped
 * listening, and the fact that none of them will fire is the headline.
 */
import { describeAge, type CronJob, type TaskSnapshot } from "./cron-store.js";

/** One line about a job, for a toast or a spoken reply. */
export function describeJob(job: CronJob, now = Date.now()): string {
  const parts: string[] = [];
  if (job.schedule) parts.push(job.schedule);
  if (job.nextRunAt !== null) {
    const delta = job.nextRunAt - now;
    parts.push(delta >= 0 ? `next in ${describeAge(delta)}` : `overdue by ${describeAge(-delta)}`);
  }
  if (job.lastRunAt === null) parts.push("never run");
  else if (job.lastStatus === "error") parts.push("last run failed");
  return parts.join(" · ");
}

/**
 * What Jarvis says out loud when asked "what's scheduled?".
 *
 * Capped at five spoken jobs. Not a display limit — a speech one: a list read
 * aloud stops being information somewhere around the fourth item, and the count
 * carries what the tail would have.
 */
export function speakTasks(snapshot: TaskSnapshot, now = Date.now()): string {
  const { jobs, warning } = snapshot;
  if (jobs.length === 0) {
    // `warning` is only ever set when jobs exist, so this is the true empty
    // case: nothing scheduled, and therefore nothing to worry about the
    // scheduler for.
    return warning ?? "Nothing is scheduled.";
  }

  const head = `${jobs.length} scheduled task${jobs.length === 1 ? "" : "s"}`;
  const listed = jobs
    .slice(0, 5)
    .map((j) => `${j.name || j.id} — ${describeJob(j, now)}`)
    .join("; ");
  const more = jobs.length > 5 ? `; and ${jobs.length - 5} more` : "";
  const body = `${head}: ${listed}${more}.`;
  return warning ? `${warning} ${body}` : body;
}
