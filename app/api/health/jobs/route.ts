import { jobHealth } from '@/lib/jobs/health'

/**
 * Missed-run detection, for an alert to poll. 200 while every scheduled job
 * has succeeded within its grace period; 503, naming the jobs, when any has
 * not. The availability test in `infra/` hits this and emails whoever the
 * deployment names. See `lib/jobs/health.ts`.
 *
 * Unauthenticated: job names and timestamps are not sensitive, and an alert
 * that needs a secret is one more thing to break.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const overdue = await jobHealth()
    return Response.json(
      {
        ok: overdue.length === 0,
        overdue: overdue.map((job) => ({
          job: job.jobName,
          cadence: job.cadence,
          lastSucceededAt: job.lastSucceededAt?.toISOString() ?? null,
        })),
      },
      { status: overdue.length === 0 ? 200 : 503 },
    )
  } catch (error) {
    console.error('Job health check failed', error)
    return Response.json({ ok: false, error: 'Could not read the run log.' }, { status: 503 })
  }
}
