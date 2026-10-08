import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

const REQUESTER = 'music@example.test' // Robin: salaried, chain is Dana, then Morgan
const STEP_1 = 'pastor@example.test' // Dana
const STEP_2 = ADMIN // Morgan
const HOURLY = 'custodian@example.test' // Sam

async function signIn(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

/**
 * Weekdays over a year out, different on each run, so this suite neither
 * collides with the requests suite's dates nor with a run that failed
 * half-way. Still inside the window the request form accepts.
 */
function candidateDays(): string[] {
  const base = Date.now() + (420 + (Date.now() % 200)) * 86_400_000
  const days: string[] = []
  for (let i = 0; days.length < 10; i++) {
    const date = new Date(base + i * 86_400_000)
    const weekday = date.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days.push(date.toISOString().slice(0, 10))
  }
  return days
}

async function approveAs(page: Page, email: string, path: string) {
  await signIn(page, email)
  await page.goto('/approvals')
  await page.locator(`a[href="${path}"]:visible`).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
}

test('approved leave reaches the dashboard, the history and the filtered list', async ({ page }) => {
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

  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page).toHaveURL(/\/requests\/(?!new$)[a-z0-9]+$/)
  const path = new URL(page.url()).pathname
  const link = page.locator(`a[href="${path}"]:visible`)

  // Pending: listed under Pending with where it sits in the chain, and
  // reachable from the dashboard.
  await page.goto('/')
  await page.getByRole('link', { name: /waiting for approval/ }).click()
  await expect(page).toHaveURL('/requests?status=PENDING')
  await expect(link).toBeVisible()
  await expect(page.getByRole('row').filter({ has: link })).toContainText(
    'Dana Whitfield (step 1 of 2)',
  )
  await page.getByRole('navigation', { name: 'Status' }).getByRole('link', { name: /^Approved/ }).click()
  await expect(link).toHaveCount(0)

  await approveAs(page, STEP_1, path)
  await approveAs(page, STEP_2, path)

  await signIn(page, REQUESTER)
  await expect(
    page.getByRole('region', { name: 'Upcoming time off' }).locator(`a[href="${path}"]`),
  ).toBeVisible()

  await page.goto('/requests?status=APPROVED')
  await expect(link).toBeVisible()

  await page.goto('/history')
  await expect(page.locator(`[data-date="${date}"]`)).toHaveAttribute('data-minutes', '480')
  await expect(page.getByRole('region', { name: 'Days' }).locator(`a[href="${path}"]`)).toBeVisible()

  // Cancelled leave leaves the history.
  await page.goto(path)
  await page.getByRole('button', { name: 'Cancel request' }).click()
  // Not "given back": the cancel section says that before anything happens,
  // so waiting on it raced the action to /history.
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
  await page.goto('/history')
  // Its year's grid may be gone altogether, if nothing else is in it.
  await expect(page.locator(`[data-date="${date}"][data-minutes]`)).toHaveCount(0)
})

test('an hourly employee is never shown comp time', async ({ page }) => {
  await signIn(page, HOURLY)
  await expect(page.getByRole('listitem', { name: 'PTO balance' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: 'Sick balance' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: 'Comp Time balance' })).toHaveCount(0)
})

test('a filter that does not parse shows the whole list', async ({ page }) => {
  await signIn(page, REQUESTER)
  const response = await page.goto("/requests?status=nonsense&type=%27%20OR%201%3D1")
  expect(response?.status()).toBe(200)
  await expect(
    page.getByRole('navigation', { name: 'Status' }).getByRole('link', { name: /^All/ }),
  ).toHaveAttribute('aria-current', 'page')

  expect((await page.goto('/history?year=last'))?.status()).toBe(200)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  for (const path of ['/', '/requests', '/requests/new', '/history', '/approvals', '/notifications']) {
    test(`${path} fits without scrolling sideways`, async ({ page }) => {
      await signIn(page, REQUESTER)
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })
  }
})
