'use server'

import { revalidatePath } from 'next/cache'

import { writeAudit } from '@/lib/audit'
import { ForbiddenError, requireAdminOrThrow } from '@/lib/authz'
import type { ActionResult } from '@/lib/employees/actions'

import { isJobName, jobByName, type JobName } from './catalog'
import { jobDate } from './request'
import { runJob } from './runner'

export type { ActionResult }

/**
 * Running a job by hand, from the admin screen.
 *
 * The scheduled route under `/api/jobs` authenticates with a shared secret;
 * this authenticates as an administrator. Both end in the same `runJob`
 * wrapper writing the same `JobRun`, so a hand-run and a cron run are
 * indistinguishable afterwards — which is what makes the run log trustworthy.
 *
 * Safe to use freely: every job is idempotent, so pressing the button twice
 * grants nothing twice.
 */
export async function runJobNow(
  jobName: JobName,
  _previousState?: ActionResult | null,
  formData?: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    // The name arrives bound from a server component, but it crosses the
    // network on its way back, so it is checked like any other input.
    if (!isJobName(jobName)) return { ok: false, error: `Unknown job "${jobName}".` }

    // An explicit date lets an administrator backfill a day the scheduler
    // missed, which every job is written to tolerate.
    const requested = formData?.get('date')
    const asOf = jobDate(typeof requested === 'string' && requested ? requested : null)

    const result = await runJob({ jobName, periodKey: asOf.toISOString().slice(0, 10) }, (run) =>
      jobByName(jobName)(asOf, run),
    )

    await writeAudit({
      actorId: actor.id,
      action: 'job.run',
      entityType: 'JobRun',
      entityId: result.jobRunId,
      after: {
        jobName,
        asOf: asOf.toISOString().slice(0, 10),
        entriesCreated: result.entriesCreated,
      },
      reason: 'Run by hand from the admin screen',
    })

    revalidatePath('/admin/jobs')
    revalidatePath('/admin/ledger')
    return { ok: true }
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message }
    console.error(error)
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The job failed. Check the run log.',
    }
  }
}
