import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

const REQUESTER = 'music@example.test' // Robin: chain is Dana, then Morgan
const STEP_1 = 'pastor@example.test' // Dana
const STEP_2 = ADMIN // Morgan
const OUTSIDER = 'custodian@example.test'

async function signIn(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

/**
 * A weekday a few months out, different on each run so a run that failed
 * half-way and left a request behind cannot block the next one.
 */
function candidateDays(): string[] {
  const base = Date.now() + (60 + (Date.now() % 200)) * 86_400_000
  const days: string[] = []
  for (let i = 0; days.length < 10; i++) {
    const date = new Date(base + i * 86_400_000)
    const weekday = date.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days.push(date.toISOString().slice(0, 10))
  }
  return days
}

test('a request moves through a two-step chain, moves the balance, and can be cancelled', async ({
  page,
}) => {
  await signIn(page, REQUESTER)
  await page.goto('/requests/new')
  const leaveType = page.getByLabel('Leave type')
  const pto = await leaveType.locator('option', { hasText: /^PTO/ }).getAttribute('value')
  await leaveType.selectOption(pto ?? '')

  // Use the first candidate that is not a holiday — a holiday has no picker.
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
  await expect(page.getByText('After this request:')).toBeVisible()

  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page).toHaveURL(/\/requests\/(?!new$)[a-z0-9]+$/)
  const url = page.url()

  await expect(page.getByText('Pending', { exact: true })).toBeVisible()
  await expect(page.getByText('Waiting', { exact: true })).toBeVisible()

  // Nobody outside the request can see it.
  await signIn(page, OUTSIDER)
  const response = await page.goto(url)
  expect(response?.status()).toBe(404)

  // Step 1.
  await signIn(page, STEP_1)
  await page.goto('/approvals')
  await page.locator(`a[href="${new URL(url).pathname}"]:visible`).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  // The decision panel goes once the step is decided; the step says so instead.
  await expect(page.getByRole('listitem').filter({ hasText: 'Step 1:' })).toContainText('Approved')
  await expect(page.getByRole('listitem').filter({ hasText: 'Step 2:' })).toContainText('Waiting')

  // Step 2 — the request only reaches Morgan's inbox now.
  await signIn(page, STEP_2)
  await page.goto('/approvals')
  await page.locator(`a[href="${new URL(url).pathname}"]:visible`).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByText('taken')).toBeVisible()

  // Back to Robin, who changes their mind.
  await signIn(page, REQUESTER)
  await page.goto(url)
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Cancel request' }).click()
  await expect(page.getByText('given back')).toBeVisible()
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible()
})

test('a three-hour day is never offered at a half-day increment', async ({ page }) => {
  await signIn(page, REQUESTER)
  await page.goto('/requests/new')

  const [date] = candidateDays()
  await page.getByLabel('First day').fill(date)
  await page.getByLabel('Last day').fill(date)

  const picker = page.locator(`select[name="day.${date}"]`)
  await expect(picker.locator('option')).toHaveText(['None', 'Half day', 'Full day'])
})
