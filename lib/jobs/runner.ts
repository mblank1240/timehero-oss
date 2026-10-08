/**
 * Running a scheduled job, and proving the caller is allowed to.
 *
 * The jobs are a handful of HTTP calls on a schedule, triggered by GitHub
 * Actions cron against authenticated routes — one repo, one deployment target,
 * logs beside the deploy logs (docs/DECISIONS.md). GitHub's scheduled triggers
 * can run late under load, so every job is written to tolerate that: they are
 * idempotent, they take the date they are acting on as an argument, and they
 * are safe to re-run for a past one.
 *
 * Every execution writes a `JobRun`, successful or not. It is the place to
 * look when someone asks why an accrual is missing.
 */

import type { Prisma } from '@prisma/client'

import { db } from '@/lib/db'

export type JobOutcome = {
  /** Rows actually written — zero on a re-run, which is the point. */
  entriesCreated: number
  /** Anything worth reading in the run log. */
  detail?: Record<string, unknown>
}

/**
 * What a job is told about the run it belongs to. A job that writes ledger
 * entries stamps them with `jobRunId`, which is how one run's work is found —
 * and, in Phase 10, reversed.
 */
export type JobRunContext = { jobRunId: string }

export type JobResult = JobOutcome & {
  jobRunId: string
  jobName: string
  periodKey: string | null
}

/**
 * Wraps a job in its `JobRun` row.
 *
 * A failure is recorded and re-thrown: the row is what makes a silent
 * never-ran distinguishable from a loud failed-at-3am, and the throw is what
 * turns the workflow red so somebody finds out.
 */
export async function runJob(
  args: { jobName: string; periodKey?: string | null },
  work: (run: JobRunContext) => Promise<JobOutcome>,
): Promise<JobResult> {
  const run = await db.jobRun.create({
    data: { jobName: args.jobName, periodKey: args.periodKey ?? null },
    select: { id: true },
  })

  try {
    const outcome = await work({ jobRunId: run.id })

    await db.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        entriesCreated: outcome.entriesCreated,
        detail: (outcome.detail ?? null) as Prisma.InputJsonValue,
      },
    })

    return { ...outcome, jobRunId: run.id, jobName: args.jobName, periodKey: args.periodKey ?? null }
  } catch (error) {
    await db.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
    })
    throw error
  }
}
