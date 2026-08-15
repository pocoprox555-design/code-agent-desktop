import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'node:path'

const mainEntry = path.resolve(__dirname, '..', '..', 'out', 'main', 'index.js')

test('Build page opens its empty state without a project', async () => {
  const electronApp = await electron.launch({ args: [mainEntry], executablePath: require('electron') })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const settingsClose = page.getByRole('button', { name: 'إغلاق الإعدادات' })
    if (await settingsClose.isVisible()) await settingsClose.click()
    await page.locator('.sidebar-settings[aria-label="بناء ومعاينة"]').click()
    await expect(page.locator('.build-empty')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /مشروع جديد من قالب/ })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
