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

const DAILY_HOUR = 7

/** The batches due at this UTC minute. Each batch runs its jobs in order. */
function due(now) {
  const minute = now.getUTCMinutes()
  const hour = now.getUTCHours()
  const batches = []
  if (hour === DAILY_HOUR && minute === 0) batches.push(DAILY)
  if (now.getUTCDay() === 0 && hour === 6 && minute === 0) batches.push(['generate-pay-periods'])
  if (minute === 15) batches.push(['send-notifications'])
  return batches
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

/**
 * Batches run alongside each other, not one after another: the daily batch
 * can take minutes, and the hourly notifications must not wait on it (nor
 * miss their minute because of it). A batch still running when it comes due
 * again is not started twice.
 */
const running = new Set()
function start(batch) {
  const name = batch.join(',')
  if (running.has(name)) return
  running.add(name)
  ;(async () => {
    for (const job of batch) await run(job)
  })().finally(() => running.delete(name))
}

let last = ''
function tick() {
  const now = new Date()
  const key = now.toISOString().slice(0, 16)
  if (key !== last) {
    last = key
    for (const batch of due(now)) start(batch)
  }
  setTimeout(tick, 20_000)
}

console.log(`Scheduler posting to ${BASE_URL}/api/jobs`)

// A container that was down at the daily hour — restarted, upgraded, the host
// rebooted — would otherwise skip that day. The jobs are idempotent, so running
// the batch again after a start later in the day changes nothing if it did run.
const startedAt = new Date()
if (startedAt.getUTCHours() * 60 + startedAt.getUTCMinutes() > DAILY_HOUR * 60) {
  console.log('Started after the daily run time: running the daily jobs now in case they were missed.')
  start(DAILY)
}
tick()
