/**
 * The scheduled jobs for a self-hosted install: the same timetable as
 * .github/workflows/jobs.yml, posting to the app's /api/jobs routes with
 * JOBS_SECRET. Runs as its own container from the app image.
 *
 * Every job is idempotent and takes the date it acts on, so a run that fires
 * twice changes nothing, and one that was missed is recovered from
 * Admin → Jobs. Times are UTC.
 */

const BASE_URL = (process.env.JOBS_BASE_URL ?? 'http://app:3000').replace(/\/$/, '')
const SECRET = process.env.JOBS_SECRET

if (!SECRET) {
  console.error('JOBS_SECRET is not set; the scheduler cannot authenticate.')
  process.exit(1)
}

// Order matters on one day a year: a lot expiring on the old year's last day
// is settled before the rollover reads the balance.
const DAILY = [
  'expire-lots',
  'benefit-year-rollover',
  'accrue-pay-period',
  'create-timesheets',
  'sync-directory',
]

/** The jobs due at this UTC minute. */
function due(now) {
  const minute = now.getUTCMinutes()
  const hour = now.getUTCHours()
  const jobs = []
  if (hour === 7 && minute === 0) jobs.push(...DAILY)
  if (now.getUTCDay() === 0 && hour === 6 && minute === 0) jobs.push('generate-pay-periods')
  if (minute === 15) jobs.push('send-notifications')
  return jobs
}

async function run(job) {
  try {
    const response = await fetch(`${BASE_URL}/api/jobs/${job}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(300_000),
    })
    const body = await response.text()
    console.log(`${new Date().toISOString()} ${job} ${response.status} ${body}`)
  } catch (error) {
    console.error(`${new Date().toISOString()} ${job} failed: ${error}`)
  }
}

let last = ''
async function tick() {
  const now = new Date()
  const key = now.toISOString().slice(0, 16)
  if (key !== last) {
    last = key
    for (const job of due(now)) await run(job)
  }
  setTimeout(tick, 20_000)
}

console.log(`Scheduler posting to ${BASE_URL}/api/jobs`)
tick()
