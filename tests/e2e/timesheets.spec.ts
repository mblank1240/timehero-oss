import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

const HOURLY = 'custodian@example.test' // Sam: hourly, no chain, so any administrator approves
const APPROVER = 'pastor@example.test' // Dana, an administrator
const FINANCE = 'finance@example.test' // Lee: reads and exports, changes nothing

async function signIn(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

/**
 * Makes sure Sam has a timesheet for the open period and that it is open:
 * runs the creation job as an administrator, then unlocks the timesheet if an
 * earlier run of this test left it submitted or approved. Returns its path.
 */
async function openTimesheet(page: Page): Promise<string> {
  await signIn(page, ADMIN)
  await page.goto('/admin/jobs')
  const card = page.getByRole('listitem').filter({ hasText: 'create-timesheets' })
  await card.getByRole('button', { name: 'Run now' }).click()
  await expect(card.getByText('Done — see the run log below.')).toBeVisible()

  await page.goto('/reports/timesheets')
  // Followed rather than clicked: at phone width the dev-tools badge sits
  // over the table's first column.
  const path = await page.getByRole('link', { name: 'Okafor, Sam' }).getAttribute('href')
  expect(path).toMatch(/^\/timesheets\/[a-z0-9]+$/)
  await page.goto(path!)

  if (await page.getByRole('heading', { name: 'Unlock' }).isVisible()) {
    await page.getByLabel('Reason for unlocking').fill('Resetting for the end-to-end test')
    await page.getByRole('button', { name: 'Unlock timesheet' }).click()
    await expect(page.getByText('Open', { exact: true })).toBeVisible()
  }
  return path!
}

test('an hourly employee completes a pay period and an administrator exports it', async ({
  page,
}) => {
  const path = await openTimesheet(page)

  await signIn(page, HOURLY)
  await page.getByRole('navigation').getByRole('link', { name: 'Timesheets' }).click()
  await page.locator(`a[href="${path}"]`).click()
  await expect(page).toHaveURL(path)

  const worked = page.getByLabel(/^Time worked on /)
  const notes = page.getByLabel(/^Note for /)

  // Off the 15-minute increment: refused, with the day marked.
  await worked.nth(0).fill('7h 10m')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Please correct the highlighted days.')).toBeVisible()
  await expect(page.getByText('Record time worked in steps of 15 minutes.')).toBeVisible()

  await worked.nth(0).fill('7h 30m')
  await worked.nth(1).fill('8:15')
  await notes.nth(1).fill('Stayed late to set up for the fall festival')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByRole('definition').filter({ hasText: '15h 45m' }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Save and submit' }).click()
  await expect(page.getByText('Submitted', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Withdraw' })).toBeVisible()
  await expect(page.getByLabel(/^Time worked on /)).toHaveCount(0)

  // Any administrator but Sam can approve: it shows in Dana's inbox.
  await signIn(page, APPROVER)
  await page.goto('/approvals')
  await page.locator(`a[href="${path}"]:visible`).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()

  // The status grid and the export.
  await signIn(page, ADMIN)
  await page.goto('/reports/timesheets')
  const row = page.getByRole('row').filter({ hasText: 'Okafor, Sam' })
  await expect(row).toContainText('Approved')
  await expect(row).toContainText('15h 45m')

  const href = await page.getByRole('link', { name: 'Summary (.csv)' }).getAttribute('href')
  const csv = await page.request.get(href!)
  expect(csv.headers()['content-type']).toContain('text/csv')
  const body = await csv.text()
  expect(body.split('\r\n')[0]).toContain('Regular hours')
  expect(body).toMatch(/Okafor,Sam,custodian@example\.test,APPROVED,[A-Z ]+,15\.75,/)

  // Approved means locked, until an administrator unlocks it with a reason.
  await page.goto(path)
  await page.getByLabel('Reason for unlocking').fill('Sam forgot a shift')
  await page.getByRole('button', { name: 'Unlock timesheet' }).click()
  await expect(page.getByText('Open', { exact: true })).toBeVisible()
})

test('finance downloads one timesheet or all of them, and can change nothing', async ({ page }) => {
  const path = await openTimesheet(page)
  const timesheetId = path.split('/').at(-1)

  await signIn(page, FINANCE)
  await page.getByRole('navigation').getByRole('link', { name: 'Reports' }).click()
  await expect(page).toHaveURL('/reports/timesheets')
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Administration' }),
  ).toHaveCount(0)

  // One employee's timesheet: a row per day of the period, then the total.
  const one = await page.request.get(
    (await page
      .getByRole('link', { name: "Download Sam Okafor's timesheet" })
      .getAttribute('href'))!,
  )
  expect(one.headers()['content-disposition']).toMatch(
    /timesheet-\d{4}-\d{2}-\d{2}-okafor-sam\.csv/,
  )
  const lines = (await one.text()).trim().split('\r\n')
  expect(lines[0]).toContain('Overtime hours')
  expect(lines.at(-1)).toContain('TOTAL')
  expect(lines.length).toBeGreaterThanOrEqual(1 + 7 + 1)

  // All of them at once.
  const all = await page.request.get(
    (await page.getByRole('link', { name: 'Download all (.zip)' }).getAttribute('href'))!,
  )
  expect(all.headers()['content-type']).toBe('application/zip')
  const bytes = await all.body()
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304')
  expect(bytes.toString('latin1')).toContain('okafor-sam.csv')

  // Finance can read the timesheet but is offered nothing that changes it.
  await page.goto(path)
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute(
    'href',
    `/reports/timesheets/export?timesheet=${timesheetId}`,
  )
  await expect(page.getByRole('heading', { name: 'Unlock' })).toHaveCount(0)
  await expect(page.getByLabel(/^Time worked on /)).toHaveCount(0)

  // And the administration screens stay shut.
  await page.goto('/admin/settings')
  await expect(page).toHaveURL('/')
})

test('an ordinary employee cannot reach reports or exports', async ({ page }) => {
  await signIn(page, HOURLY)
  await page.goto('/reports/timesheets')
  await expect(page).toHaveURL('/')
  const response = await page.request.get('/reports/timesheets/export?period=anything')
  expect(response.status()).toBe(403)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('the timesheet pages fit without scrolling sideways', async ({ page }) => {
    const path = await openTimesheet(page)
    await signIn(page, HOURLY)
    for (const target of ['/timesheets', path]) {
      await page.goto(target)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, target).toBeLessThanOrEqual(0)
    }
  })
})
