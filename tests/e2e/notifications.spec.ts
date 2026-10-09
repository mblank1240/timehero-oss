import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { MAIL_DIR } from '../../playwright.config'
import { ADMIN } from './people'

const REQUESTER = 'music@example.test' // Robin Alvarez: chain is Dana, then Morgan
const APPROVER = 'pastor@example.test' // Dana
const HOURLY = 'custodian@example.test' // Sam
const FINANCE = 'finance@example.test' // Lee Chen

async function signIn(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

/**
 * The sending address the organization has set, read where an administrator
 * sets it. The seed's sample data sets one, but a developer's database may
 * hold their own, and the tests follow whichever it is.
 */
async function configuredMailFrom(page: Page): Promise<string> {
  await signIn(page, ADMIN)
  await page.goto('/admin/notifications')
  const address = await page.getByLabel('Send email from').inputValue()
  expect(address, 'set a sending address under Administration → Notifications').not.toBe('')
  return address
}

/** Messages the dev server's file transport wrote to `to` since `since`. */
async function mailTo(to: string, since: number) {
  const files = (await readdir(MAIL_DIR).catch(() => [] as string[])).sort().reverse()
  const found: { from: string; subject: string; text: string }[] = []
  for (const file of files) {
    if (Number(file.split('-')[0]) < since) break
    const mail = JSON.parse(await readFile(path.join(MAIL_DIR, file), 'utf8'))
    if (mail.to === to) found.push(mail)
  }
  return found
}

/** A weekday a few months out, different each run; see requests.spec.ts. */
function candidateDays(): string[] {
  const base = Date.now() + (90 + (Date.now() % 150)) * 86_400_000
  const days: string[] = []
  for (let i = 0; days.length < 10; i++) {
    const date = new Date(base + i * 86_400_000)
    const weekday = date.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days.push(date.toISOString().slice(0, 10))
  }
  return days
}

test('an approver is told a request is waiting — in the app and by email', async ({ page }) => {
  const mailFrom = await configuredMailFrom(page)
  const since = Date.now()

  await signIn(page, REQUESTER)
  await page.goto('/requests/new')
  const leaveType = page.getByLabel('Leave type')
  const pto = await leaveType.locator('option', { hasText: /^PTO/ }).getAttribute('value')
  await leaveType.selectOption(pto ?? '')
  let date = ''
  for (const candidate of candidateDays()) {
    await page.getByLabel('First day').fill(candidate)
    await page.getByLabel('Last day').fill(candidate)
    if ((await page.locator(`select[name="day.${candidate}"]`).count()) > 0) {
      date = candidate
      break
    }
  }
  expect(date, 'no non-holiday weekday found').not.toBe('')
  await page.locator(`select[name="day.${date}"]`).selectOption({ label: 'Half day' })
  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page).toHaveURL(/\/requests\/(?!new$)[a-z0-9]+$/)
  const requestPath = new URL(page.url()).pathname

  // The email goes out once the submission's response has: from the address
  // the church set, never from anything in the environment.
  await expect
    .poll(async () => (await mailTo(APPROVER, since)).length, { timeout: 15_000 })
    .toBe(1)
  const [mail] = await mailTo(APPROVER, since)
  expect(mail.from).toBe(mailFrom)
  expect(mail.subject).toBe('Leave request waiting on you')
  expect(mail.text).toContain(requestPath)

  await signIn(page, APPROVER)
  await expect(page.getByRole('link', { name: /^Notifications, \d+ unread$/ })).toBeVisible()
  await page.getByRole('link', { name: /^Notifications/ }).click()
  const item = page
    .getByRole('list', { name: 'Notifications' })
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="${requestPath}"]`) })
  await expect(item).toContainText('Leave request waiting on you')
  await expect(item).toContainText('Robin')

  await page.getByRole('button', { name: 'Mark all read' }).click()
  await expect(page.getByText('Nothing unread.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible()

  // Tidy up: Robin withdraws it.
  await signIn(page, REQUESTER)
  await page.goto(requestPath)
  await page.getByRole('button', { name: 'Cancel request' }).click()
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible()
})

test('with no sending address there is no email, and no emailed sign-in link', async ({
  page,
}) => {
  const mailFrom = await configuredMailFrom(page)
  const address = page.getByLabel('Send email from')

  try {
    await address.fill('')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Settings saved.')).toBeVisible()
    await page.reload()
    await expect(page.getByText('Off: no sending address set below')).toBeVisible()

    await page.context().clearCookies()
    await page.goto('/signin')
    await expect(page.getByLabel('Employee email')).toBeVisible()
    await expect(page.getByLabel('Email me a sign-in link')).toHaveCount(0)

    await signIn(page, HOURLY)
    await page.goto('/notifications')
    await expect(page.getByText('Your organization does not send email.')).toBeVisible()
  } finally {
    await signIn(page, ADMIN)
    await page.goto('/admin/notifications')
    await page.getByLabel('Send email from').fill(mailFrom)
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Settings saved.')).toBeVisible()
  }

  await page.context().clearCookies()
  await page.goto('/signin')
  await expect(page.getByLabel('Email me a sign-in link')).toBeVisible()
})

test('an employee chooses how each notification reaches them', async ({ page }) => {
  const mailFrom = await configuredMailFrom(page)
  await signIn(page, HOURLY)
  await page.goto('/notifications')
  await expect(page.getByText(`by email from ${mailFrom}`, { exact: false })).toBeVisible()
  // Not an administrator: no rollover summary to choose about.
  await expect(page.getByText('Year-end rollover')).toHaveCount(0)

  const decisionsByEmail = page.getByLabel('Decisions by email')
  await expect(decisionsByEmail).toBeChecked()
  await decisionsByEmail.uncheck()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Decisions by email')).not.toBeChecked()
  await expect(page.getByLabel('Decisions by push')).toBeChecked()

  await page.getByLabel('Decisions by email').check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
})

test('finance reads and downloads every report', async ({ page }) => {
  // The ledger report below looks for Robin's annual grant. The seed writes no
  // ledger rows, so the grant is made the way production makes it: by the
  // accrual job. It is idempotent, so a database that already has the grant
  // gets nothing twice.
  await signIn(page, ADMIN)
  await page.goto('/admin/jobs')
  const accrual = page.getByRole('listitem').filter({ hasText: 'accrue-pay-period' })
  await accrual.getByRole('button', { name: 'Run now' }).click()
  await expect(accrual.getByText('Done — see the run log below.')).toBeVisible()

  await signIn(page, FINANCE)
  await page.goto('/reports/balances')
  await expect(page.getByRole('heading', { name: 'Balances' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Alvarez, Robin' })).toBeVisible()

  const csv = async (label: string) => {
    const href = await page.getByRole('link', { name: label }).getAttribute('href')
    const response = await page.request.get(href!)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/csv')
    return (await response.text()).split('\r\n')
  }

  const balances = await csv('Download (.csv)')
  expect(balances[0]).toMatch(/^As of,Last name,First name,Email,.*PTO hours/)
  expect(balances.some((line) => line.includes(',Alvarez,Robin,music@example.test,'))).toBe(true)

  await page.getByRole('navigation', { name: 'Reports' }).getByRole('link', { name: 'Leave taken' }).click()
  await expect(page.getByRole('heading', { name: 'Leave taken' })).toBeVisible()
  expect((await csv('Summary (.csv)'))[0]).toBe(
    'From,To,Last name,First name,Email,Leave type,Days taken,Hours,Minutes',
  )
  expect((await csv('Every day (.csv)'))[0]).toBe(
    'Date,Last name,First name,Email,Leave type,Hours,Minutes',
  )

  await page.getByRole('navigation', { name: 'Reports' }).getByRole('link', { name: 'Forfeitures' }).click()
  await expect(page.getByRole('heading', { name: 'Forfeitures' })).toBeVisible()
  expect((await csv('Download (.csv)'))[0]).toMatch(/^Date,Last name,.*,Reason,Hours forfeited/)

  await page.getByRole('navigation', { name: 'Reports' }).getByRole('link', { name: 'Employee ledger' }).click()
  await page.getByLabel('Employee').selectOption({ label: 'Alvarez, Robin' })
  await page.getByRole('button', { name: 'Show' }).click()
  await expect(page.getByRole('cell', { name: 'Annual grant' }).first()).toBeVisible()
  const ledger = await csv('Download (.csv)')
  expect(ledger[0]).toMatch(/^Last name,First name,Email,Date,Leave type,Kind,/)
  expect(ledger.length).toBeGreaterThan(2)

  // Read-only: an export is refused to someone who is not finance or an admin.
  await signIn(page, HOURLY)
  const refused = await page.request.get('/reports/export?report=balances')
  expect(refused.status()).toBe(403)
})
