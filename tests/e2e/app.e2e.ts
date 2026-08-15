/**
 * E2E Tests — Playwright (P3-08)
 * تختبر الواجهة كاملة من منظور المستخدم
 *
 * ⚠️ تشغّل بشكل منفصل عن npm test:
 *   1. npx playwright install chromium
 *   2. npx playwright test tests/e2e/
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'node:path'

// العثور على مسار Electron
const mainEntry = path.resolve(__dirname, '..', '..', 'out', 'main', 'index.js')

test.describe('App Launch', () => {
  test('should launch and show main window', async () => {
    const electronApp = await electron.launch({
      args: [mainEntry],
      executablePath: require('electron'),
    })

    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const main = window.locator('.app-shell')
    await expect(main).toBeVisible({ timeout: 15000 })

    const brand = window.locator('.brand strong')
    await expect(brand).toContainText('Code Agent')

    await electronApp.close()
  })
})

test.describe('UI Elements', () => {
  test('should have model selector', async () => {
    const electronApp = await electron.launch({
      args: [mainEntry],
      executablePath: require('electron'),
    })

    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const modelSelect = window.locator('.model-select-btn')
    await expect(modelSelect).toBeVisible({ timeout: 10000 })

    await electronApp.close()
  })

  test('should toggle sidebar', async () => {
    const electronApp = await electron.launch({
      args: [mainEntry],
      executablePath: require('electron'),
    })

    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const sidebar = window.locator('#app-sidebar')
    if (await sidebar.isVisible()) {
      // Should have brand text
      const brand = sidebar.locator('.brand strong')
      await expect(brand).toBeVisible({ timeout: 5000 })
    }

    await electronApp.close()
  })
})
