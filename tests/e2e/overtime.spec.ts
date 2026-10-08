import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

const WORKER = 'music@example.test' // Robin: salaried exempt, chain is Dana, then Morgan
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
 * Recent past days, a different set on each run, so a log left by an earlier
 * run does not trip the one-log-a-day rule. Within the last two months, so
 * they stay in the current benefit year for most of it.
 */
function candidateDays(): string[] {
  const start = 1 + (Math.floor(Date.now() / 1000) % 50)
  return Array.from({ length: 10 }, (_, i) =>
    new Date(Date.now() - (start + i) * 86_400_000).toISOString().slice(0, 10),
  )
}

async function approveAs(page: Page, email: string, path: string) {
  await signIn(page, email)
  await page.goto('/approvals')
  await page.locator(`a[href="${path}"]:visible`).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your decision' })).toHaveCount(0)
}

test('an exempt employee banks approved overtime as comp time', async ({ page }) => {
  await signIn(page, WORKER)
  await page.getByRole('navigation').getByRole('link', { name: 'Overtime' }).click()
  await page.getByRole('link', { name: 'Log overtime' }).click()

  let submitted = false
  for (const day of candidateDays()) {
    await page.getByLabel('Date worked').fill(day)
    await page.getByLabel('Time worked beyond your normal hours').fill('2h 15m')
    await page.getByLabel('What it was for').fill('Evening rehearsal for the Christmas concert')
    await page.getByRole('button', { name: 'Submit for approval' }).click()
    await page.waitForURL(/\/overtime\/(?!new$)[a-z0-9]+$/, { timeout: 3000 }).catch(() => {})
    if (/\/overtime\/(?!new$)[a-z0-9]+$/.test(new URL(page.url()).pathname)) {
      submitted = true
      break
    }
    await expect(page.getByRole('alert')).toContainText('already logged')
  }
  expect(submitted, 'every candidate day already had a log').toBe(true)

  const path = new URL(page.url()).pathname
  await expect(page.getByText('Pending', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'If approved' })).toBeVisible()

  await approveAs(page, STEP_1, path)
  await approveAs(page, STEP_2, path)

  await signIn(page, WORKER)
  await page.goto(path)
  await expect(page.getByText('Approved', { exact: true })).toBeVisible()
  await expect(page.getByText(/banked/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ledger' })).toBeVisible()

  // Spendable: Comp Time is offered on the request form.
  await page.goto('/requests/new')
  await expect(page.getByLabel('Leave type').locator('option', { hasText: /^Comp Time/ })).toHaveCount(1)
})

test('an hourly employee is not offered overtime and cannot log it', async ({ page }) => {
  await signIn(page, HOURLY)
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Overtime' })).toHaveCount(0)

  await page.goto('/overtime/new')
  await expect(page.getByText(/only for salaried exempt staff/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  for (const path of ['/overtime', '/overtime/new']) {
    test(`${path} fits without scrolling sideways`, async ({ page }) => {
      await signIn(page, WORKER)
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })
  }
})
