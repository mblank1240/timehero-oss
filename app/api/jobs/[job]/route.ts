import type { NextRequest } from 'next/server'

import { isJobName, jobByName, JOB_NAMES } from '@/lib/jobs/catalog'
import { authorizeJobRequest, jobDate } from '@/lib/jobs/request'
import { runJob } from '@/lib/jobs/runner'

/**
 * The scheduled job endpoint.
 *
 * GitHub Actions cron posts here with the shared secret; nothing else may run
 * an accrual. One route rather than four keeps the authentication, the
 * `JobRun` record and the error shape in a single place — the jobs differ only
 * in which function they call.
 *
 * `POST` only. A job writes to the ledger, and a GET would be reachable by
 * anything that follows a link, cached by anything that caches, and retried by
 * anything that retries.
 *
 * Every job takes the date it acts on, defaulting to today, so a late run and
 * a deliberate backfill are the same code path:
 *
 *     curl -X POST -H "Authorization: Bearer $JOBS_SECRET" \
 *       "$BASE_URL/api/jobs/accrue-pay-period?date=2026-01-14"
 */

export async function POST(request: NextRequest, ctx: RouteContext<'/api/jobs/[job]'>) {
  const auth = authorizeJobRequest(request)
  if (!auth.ok) {
    return Response.json({ ok: false, error: auth.message }, { status: auth.status })
  }

  const { job } = await ctx.params
  if (!isJobName(job)) {
    return Response.json(
      { ok: false, error: `Unknown job "${job}".`, known: JOB_NAMES },
      { status: 404 },
    )
  }

  let asOf: Date
  try {
    asOf = jobDate(request.nextUrl.searchParams.get('date'))
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Invalid date.' },
      { status: 400 },
    )
  }

  try {
    const result = await runJob({ jobName: job, periodKey: asOf.toISOString().slice(0, 10) }, (run) =>
      jobByName(job)(asOf, run),
    )
    return Response.json({ ok: true, ...result })
  } catch (error) {
    // The JobRun row already records the failure; this is what turns the
    // workflow red so somebody finds out the same morning.
    console.error(`Job "${job}" failed`, error)
    return Response.json(
      { ok: false, job, error: error instanceof Error ? error.message : 'Job failed.' },
      { status: 500 },
    )
  }
}
