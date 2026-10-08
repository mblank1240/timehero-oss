import { requireAdmin } from '@/lib/authz'
import { db } from '@/lib/db'
import { runJobNow } from '@/lib/jobs/actions'
import { JOB_DESCRIPTIONS, JOB_NAMES } from '@/lib/jobs/catalog'
import { jobHealth } from '@/lib/jobs/health'

import { JobRunner } from './job-runner'

export const metadata = { title: 'Jobs · TimeHero' }

/**
 * What the scheduled jobs did, and a way to run one by hand.
 *
 * In production these fire from a GitHub Actions cron against
 * `/api/jobs/<name>`. The buttons here go through the same `runJob` wrapper
 * and write the same `JobRun`, so a hand-run and a scheduled run look
 * identical afterwards. Every job is idempotent, so nothing here can
 * double-grant by being pressed twice.
 */
export default async function JobsPage() {
  await requireAdmin()
  const [runs, overdue] = await Promise.all([
    db.jobRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
    jobHealth(),
  ])

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="mt-1 text-sm text-muted">
          The scheduled work that keeps balances current. Each job is safe to re-run — a
          second run for the same date writes nothing, because every entry carries an
          idempotency key.
        </p>
      </div>

      {overdue.length > 0 && (
        <section className="th-card space-y-2 border-danger" aria-labelledby="overdue-heading">
          <h2 id="overdue-heading" className="font-semibold text-danger">
            Not run on schedule
          </h2>
          <p className="text-sm text-muted">
            These have not succeeded as recently as their schedule says they should. In
            production that means the scheduled workflow has stopped or is failing; run the
            missed dates below once it is fixed.
          </p>
          <ul className="text-sm">
            {overdue.map((job) => (
              <li key={job.jobName}>
                <span className="font-medium">{job.jobName}</span> ({job.cadence}) — last
                succeeded{' '}
                {job.lastSucceededAt
                  ? job.lastSucceededAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
                  : 'never'}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Run a job</h2>
        <ul className="space-y-4">
          {JOB_NAMES.map((name) => (
            <li key={name} className="th-card space-y-3">
              <div>
                <p className="font-medium">{name}</p>
                <p className="mt-1 text-sm text-muted">{JOB_DESCRIPTIONS[name]}</p>
              </div>
              <JobRunner action={runJobNow.bind(null, name)} />
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">Nothing has run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Started</th>
                  <th className="py-2 pr-4 font-medium">Job</th>
                  <th className="py-2 pr-4 font-medium">For</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 text-right font-medium">Entries</th>
                  <th className="py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                      {run.startedAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{run.jobName}</td>
                    <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                      {run.periodKey ?? '—'}
                    </td>
                    <td
                      className={`py-2 pr-4 ${run.status === 'FAILED' ? 'text-danger' : ''}`}
                    >
                      {run.status.toLowerCase()}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{run.entriesCreated}</td>
                    <td
                      className={`max-w-md truncate py-2 text-xs ${
                        run.error ? 'text-danger' : 'text-muted'
                      }`}
                      title={run.error ?? summarize(run.detail)}
                    >
                      {run.error ?? summarize(run.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * The run's own summary, flattened to one line. A failed run shows its error
 * here instead — the two never appear together, so the column reads as "what
 * happened" either way.
 */
function summarize(detail: unknown): string {
  if (detail === null || typeof detail !== 'object') return ''

  return Object.entries(detail as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ')
}
