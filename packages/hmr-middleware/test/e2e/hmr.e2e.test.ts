/**
 * E2E tests for HMR middleware.
 *
 * These tests verify real HMR behavior by:
 * 1. Modifying files on disk
 * 2. Waiting for HMR updates via SSE
 * 3. Verifying the browser state
 */

import { test, expect, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let __dirname = path.dirname(fileURLToPath(import.meta.url))
let fixturesDir = path.join(__dirname, '../fixtures')
let appDir = path.join(fixturesDir, 'app')

/**
 * Wait for HMR SSE connection to be established.
 * This ensures the browser is ready to receive HMR updates before modifying files.
 */
async function waitForHmrConnection(page: Page) {
  await page.waitForFunction(() => (window as any).__hmr_connected === true, {
    timeout: 5000,
  })
}

// Original file contents for restoration
let originalCounter: string
let originalUtils: string
let originalComponents: string

test.beforeAll(async () => {
  // Save original files
  originalCounter = await fs.readFile(path.join(appDir, 'Counter.tsx'), 'utf-8')
  originalUtils = await fs.readFile(path.join(appDir, 'utils.ts'), 'utf-8')
  originalComponents = await fs.readFile(path.join(appDir, 'components.tsx'), 'utf-8')
})

test.afterEach(async () => {
  // Restore original files after each test
  await fs.writeFile(path.join(appDir, 'Counter.tsx'), originalCounter)
  await fs.writeFile(path.join(appDir, 'utils.ts'), originalUtils)
  await fs.writeFile(path.join(appDir, 'components.tsx'), originalComponents)
  // Small delay for esbuild to rebuild before next test
  await new Promise((r) => setTimeout(r, 100))
})

test.describe('HMR', () => {
  test('renders the counter initially', async ({ page }) => {
    await page.goto('/')

    // Wait for app to load
    await expect(page.getByTestId('app')).toBeVisible()
    await expect(page.getByTestId('count')).toHaveText('Count: 0')
  })

  test('preserves state when render body changes', async ({ page }) => {
    await page.goto('/')
    await waitForHmrConnection(page)

    // Wait for app to load
    await expect(page.getByTestId('count')).toHaveText('Count: 0')

    // Click to increment count
    await page.getByTestId('increment').click()
    await page.getByTestId('increment').click()
    await page.getByTestId('increment').click()
    await expect(page.getByTestId('count')).toHaveText('Count: 3')

    // Modify the render body (not the setup)
    let counterPath = path.join(appDir, 'Counter.tsx')
    let content = await fs.readFile(counterPath, 'utf-8')
    let modified = content.replace('Increment', 'Increment (HMR)')
    await fs.writeFile(counterPath, modified)

    // Wait for HMR update
    await expect(page.getByTestId('increment')).toHaveText('Increment (HMR)', {
      timeout: 5000,
    })

    // Count should be preserved!
    await expect(page.getByTestId('count')).toHaveText('Count: 3')
  })

  test('remounts when setup scope changes', async ({ page }) => {
    await page.goto('/')
    await waitForHmrConnection(page)

    // Wait for app to load
    await expect(page.getByTestId('count')).toHaveText('Count: 0')

    // Click to increment count
    await page.getByTestId('increment').click()
    await page.getByTestId('increment').click()
    await expect(page.getByTestId('count')).toHaveText('Count: 2')

    // Modify the setup scope (initial count value)
    let counterPath = path.join(appDir, 'Counter.tsx')
    let content = await fs.readFile(counterPath, 'utf-8')
    let modified = content.replace('let count = 0', 'let count = 100')
    await fs.writeFile(counterPath, modified)

    // Wait for HMR update - count should reset to 100 (setup changed)
    await expect(page.getByTestId('count')).toHaveText('Count: 100', {
      timeout: 5000,
    })
  })

  test('propagates changes from imported modules', async ({ page }) => {
    await page.goto('/')
    await waitForHmrConnection(page)

    // Wait for app to load
    await expect(page.getByTestId('count')).toHaveText('Count: 0')

    // Click to increment count
    await page.getByTestId('increment').click()
    await expect(page.getByTestId('count')).toHaveText('Count: 1')

    // Modify utils.ts (imported by Counter)
    let utilsPath = path.join(appDir, 'utils.ts')
    let content = await fs.readFile(utilsPath, 'utf-8')
    let modified = content.replace('Count:', 'Total:')
    await fs.writeFile(utilsPath, modified)

    // Wait for HMR update - format should change but count preserved
    await expect(page.getByTestId('count')).toHaveText('Total: 1', {
      timeout: 5000,
    })
  })

  test('handles multiple rapid changes', async ({ page }) => {
    await page.goto('/')
    await waitForHmrConnection(page)

    // Wait for app to load
    await expect(page.getByTestId('count')).toHaveText('Count: 0')

    // Click to increment count
    await page.getByTestId('increment').click()
    await expect(page.getByTestId('count')).toHaveText('Count: 1')

    // Make multiple rapid changes to utils.ts
    let utilsPath = path.join(appDir, 'utils.ts')
    let content = await fs.readFile(utilsPath, 'utf-8')

    // First change
    await fs.writeFile(utilsPath, content.replace('Count:', 'A:'))
    await new Promise((r) => setTimeout(r, 100))

    // Second change
    await fs.writeFile(utilsPath, content.replace('Count:', 'B:'))
    await new Promise((r) => setTimeout(r, 100))

    // Third change (final)
    await fs.writeFile(utilsPath, content.replace('Count:', 'Final:'))

    // Wait for final state
    await expect(page.getByTestId('count')).toHaveText('Final: 1', {
      timeout: 5000,
    })
  })
})

test.describe('Multi-Component Modules', () => {
  test('renders both components from the same module', async ({ page }) => {
    await page.goto('/')

    // Wait for all components to load
    await expect(page.getByTestId('header-title')).toHaveText('Test App')
    await expect(page.getByTestId('footer-year')).toHaveText('© 2024')
  })

  test('updates Header without affecting Footer state', async ({ page }) => {
    await page.goto('/')
    await waitForHmrConnection(page)

    // Verify initial state
    await expect(page.getByTestId('header-title')).toHaveText('Test App')
    await expect(page.getByTestId('footer-year')).toHaveText('© 2024')
    await expect(page.getByTestId('count')).toHaveText('Count: 0')

    // Increment counter to establish some state
    await page.getByTestId('increment').click()
    await page.getByTestId('increment').click()
    await expect(page.getByTestId('count')).toHaveText('Count: 2')

    // Modify only the Header's render body in components.tsx
    let componentsPath = path.join(appDir, 'components.tsx')
    let content = await fs.readFile(componentsPath, 'utf-8')
    let modified = content.replace('Test App', 'Updated Header')
    await fs.writeFile(componentsPath, modified)

    // Header should update
    await expect(page.getByTestId('header-title')).toHaveText('Updated Header', {
      timeout: 5000,
    })

    // Footer should be unchanged
    await expect(page.getByTestId('footer-year')).toHaveText('© 2024')

    // Counter state should be preserved (different module)
    await expect(page.getByTestId('count')).toHaveText('Count: 2')
  })

  test('updates Footer without affecting Header state', async ({ page }) => {
    await page.goto('/')
    await waitForHmrConnection(page)

    // Verify initial state
    await expect(page.getByTestId('header-title')).toHaveText('Test App')
    await expect(page.getByTestId('footer-year')).toHaveText('© 2024')

    // Modify only the Footer's render body in components.tsx
    let componentsPath = path.join(appDir, 'components.tsx')
    let content = await fs.readFile(componentsPath, 'utf-8')
    let modified = content.replace('© {year}', '© {year} All rights reserved')
    await fs.writeFile(componentsPath, modified)

    // Footer should update
    await expect(page.getByTestId('footer-year')).toHaveText('© 2024 All rights reserved', {
      timeout: 5000,
    })

    // Header should be unchanged
    await expect(page.getByTestId('header-title')).toHaveText('Test App')
  })

  test('remounts Header when its setup scope changes', async ({ page }) => {
    await page.goto('/')
    await waitForHmrConnection(page)

    // Verify initial state
    await expect(page.getByTestId('header-title')).toHaveText('Test App')

    // Modify the Header's setup scope (title initialization)
    let componentsPath = path.join(appDir, 'components.tsx')
    let content = await fs.readFile(componentsPath, 'utf-8')
    let modified = content.replace("let title = 'Test App'", "let title = 'New Title'")
    await fs.writeFile(componentsPath, modified)

    // Header should remount with new title
    await expect(page.getByTestId('header-title')).toHaveText('New Title', {
      timeout: 5000,
    })

    // Footer should be unchanged
    await expect(page.getByTestId('footer-year')).toHaveText('© 2024')
  })
})
