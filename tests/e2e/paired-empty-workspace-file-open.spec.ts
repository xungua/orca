import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('opens a file after closing the last remote terminal and reselecting the workspace', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'Empty workspace file open')
  const page = client.page
  try {
    await expect
      .poll(
        () =>
          page.evaluate(
            (repoPath) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === repoPath)?.id,
            testRepoPath
          ),
        { timeout: 60_000 }
      )
      .toBeTruthy()
    const worktreeId = await page.evaluate(
      ({ repoPath, environmentId }) => {
        const state = window.__store!.getState()
        const worktree = state.allWorktrees().find((candidate) => candidate.path === repoPath)!
        state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
        state.setActiveView('terminal')
        return worktree.id
      },
      { repoPath: testRepoPath, environmentId: client.environmentId }
    )

    await openFileExplorer(page)
    const terminalTab = page.locator('[data-tab-id]')
    await expect(terminalTab).toHaveCount(1)
    await terminalTab.locator('button').click()
    await expect(terminalTab).toHaveCount(0)

    await page.locator(`[role="option"][data-worktree-id="${worktreeId}"]`).click()
    await page.locator('[data-orca-explorer-shell]').getByText('README.md', { exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Orca E2E Test Repo', exact: true })
    ).toBeVisible({ timeout: 20_000 })
  } finally {
    await client.dispose()
  }
})
