import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { MAIL_DIR } from '../../playwright.config'

const HOURLY = 'custodian@example.test' // Sam

/** The newest sign-in link mailed to `to` since `since`, or null. */
async function linkMailedTo(to: string, since: number): Promise<string | null> {
  const files = (await readdir(MAIL_DIR).catch(() => [])).sort().reverse()
  for (const file of files) {
    if (Number(file.split('-')[0]) < since) break
    const mail = JSON.parse(await readFile(path.join(MAIL_DIR, file), 'utf8')) as {
      to: string
      text: string
    }
    if (mail.to === to)
      return /(https?:\/\/\S+\/signin\/link\?token=\S+)/.exec(mail.text)?.[1] ?? null
  }
  return null
}

async function askForLink(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto('/signin')
  await page.getByLabel('Email me a sign-in link').fill(email)
  await page.getByRole('button', { name: 'Send link' }).click()
  await expect(page.getByText('If that address belongs to an account')).toBeVisible()
}

test('an employee signs in with an emailed link, which works only once', async ({ page }) => {
  const since = Date.now()
  await askForLink(page, HOURLY)

  let link: string | null = null
  await expect
    .poll(async () => (link = await linkMailedTo(HOURLY, since)), { timeout: 10_000 })
    .not.toBeNull()

  // Opening the link does not sign in by itself — a mail scanner would.
  await page.goto(link!)
  await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Continue to TimeHero' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: /Welcome, Sam/ })).toBeVisible()

  // A second use is refused.
  await page.context().clearCookies()
  await page.goto(link!)
  await page.getByRole('button', { name: 'Continue to TimeHero' }).click()
  await expect(page).toHaveURL(/\/signin\?error=LinkInvalid/)
  await expect(
    page.getByText('That sign-in link has expired or has already been used.'),
  ).toBeVisible()
})

test('an unknown address is told the same thing, and nothing is sent', async ({ page }) => {
  const since = Date.now()
  const stranger = `stranger-${since}@example.test`
  await askForLink(page, stranger)
  await page.waitForTimeout(500)
  expect(await linkMailedTo(stranger, since)).toBeNull()
})
