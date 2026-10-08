import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

const EMPLOYEE = 'custodian@example.test'

async function signIn(page: Page, email: string) {
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

/**
 * Form errors only. A bare getByRole('alert') also matches Next's route
 * announcer, which appears once the client router hydrates.
 */
function formAlert(page: Page) {
  return page.locator('p[role="alert"], span[role="alert"]')
}

const LEDGER_ROUTES = ['/admin/ledger', '/admin/jobs']

test.describe('ledger access', () => {
  test('the ledger and job screens are closed to a non-admin', async ({ page }) => {
    await signIn(page, EMPLOYEE)

    for (const route of LEDGER_ROUTES) {
      await page.goto(route)
      await expect(page, `${route} should redirect a non-admin`).toHaveURL('/')
    }
  })

  test('both screens are reachable by an admin', async ({ page }) => {
    await signIn(page, ADMIN)

    for (const route of LEDGER_ROUTES) {
      await page.goto(route)
      await expect(page).toHaveURL(route)
    }
  })
})

test.describe('manual adjustments', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN)
    await page.goto('/admin/ledger')
  })

  /**
   * Whitespace, not an empty box: the browser's own `minlength` already stops
   * a short reason, so this is the case that has to reach the server to be
   * caught — which is the half of the rule that actually protects the ledger.
   */
  test('refuses an adjustment whose reason is only whitespace', async ({ page }) => {
    await page.getByLabel('Minutes').fill('480')
    await page.getByLabel('Reason').fill('      ')
    await page.getByRole('button', { name: 'Post adjustment' }).click()

    await expect(formAlert(page).first()).toBeVisible()
    await expect(page.getByText('Say why this adjustment is being made.')).toBeVisible()
  })

  test('refuses an adjustment of zero', async ({ page }) => {
    await page.getByLabel('Minutes').fill('0')
    await page.getByLabel('Reason').fill('Testing a zero adjustment')
    await page.getByRole('button', { name: 'Post adjustment' }).click()

    await expect(page.getByText('An adjustment of zero would change nothing.')).toBeVisible()
  })

  /**
   * The whole point of the ledger: the balance is the sum of the entries, so
   * posting one moves the balance and leaves a row explaining why.
   */
  test('posts an adjustment and moves the balance', async ({ page }) => {
    const reason = `E2E opening balance ${Date.now()}`

    await page.getByLabel('Minutes').fill('137')
    await page.getByLabel('Reason').fill(reason)
    await page.getByRole('button', { name: 'Post adjustment' }).click()

    await expect(page.getByText('Adjustment posted.')).toBeVisible()

    await page.reload()
    const row = page.getByRole('row').filter({ hasText: reason })
    await expect(row).toBeVisible()
    await expect(row).toContainText('adjustment')
  })
})

test.describe('running a job by hand', () => {
  test('records the run in the log', async ({ page }) => {
    await signIn(page, ADMIN)
    await page.goto('/admin/jobs')

    const card = page.getByRole('listitem').filter({ hasText: 'expire-lots' })
    await card.getByRole('button', { name: 'Run now' }).click()

    await expect(card.getByText('Done — see the run log below.')).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole('row').filter({ hasText: 'expire-lots' }).first(),
    ).toContainText('succeeded')
  })
})

/**
 * Rule 4: comp time is for exempt staff only. The database trigger only fires
 * on `COMP_EARNED`, so an adjustment is the one route that could hand an
 * hourly employee comp time under a different kind. Both ends are closed —
 * this covers the one a person can see.
 */
test.describe('comp time is not offered to hourly staff', () => {
  test('the adjustment form omits it, but the balance list still shows it', async ({ page }) => {
    await signIn(page, ADMIN)

    // Sam Okafor is the seeded hourly employee; Dana Whitfield is exempt.
    await page.goto('/admin/ledger')
    await page.getByLabel('Show the ledger for').selectOption({ label: 'Okafor, Sam' })
    await page.getByRole('button', { name: 'Show' }).click()

    const leaveType = page.getByLabel('Leave type')
    await expect(leaveType).toContainText('PTO')
    await expect(leaveType).not.toContainText('Comp Time')

    // A balance of zero on a type they cannot hold is still true and useful.
    await expect(page.getByRole('listitem').filter({ hasText: 'Comp Time' })).toBeVisible()

    await page.getByLabel('Show the ledger for').selectOption({ label: 'Whitfield, Dana' })
    await page.getByRole('button', { name: 'Show' }).click()
    await expect(page.getByLabel('Leave type')).toContainText('Comp Time')
  })
})
