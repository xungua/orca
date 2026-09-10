import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../store/types'
import {
  buildMobileSessionTabSnapshots,
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph'
import { makeState as makeGraphState } from './sync-runtime-graph-test-harness'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT
} from './web-session-tabs-sync-test-harness'

const file = {
  id: 'review-file',
  filePath: '/worktree/docs/review.md',
  relativePath: 'docs/review.md',
  worktreeId: WT,
  language: 'markdown',
  mode: 'edit' as const,
  isDirty: false
}
const snapshot = makeSnapshot([{ ...file, type: 'file', title: 'review.md', isActive: true }])
const remoteRepo = {
  id: 'repo',
  path: '/worktree',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'runtime:pro' as const
}

describe('remote file tabs retain their execution host across project switches', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('does not republish Pro tabs from a desktop that mirrors them', () => {
    const mirrored = applyWebSessionTabsSnapshot(makeState(), snapshot, 'pro')
    const state = makeGraphState({
      ...mirrored,
      repos: [remoteRepo] as AppState['repos'],
      activeWorktreeId: 'other::/project',
      settings: { activeRuntimeEnvironmentId: 'mini' } as AppState['settings']
    })
    expect(state.openFiles[0].runtimeEnvironmentId).toBe('pro')
    expect(buildMobileSessionTabSnapshots(state)).toEqual([])
  })

  it('invalidates publication when a workspace gains its remote owner', () => {
    const before = makeGraphState({ openFiles: [file] })
    const after = { ...before, repos: [remoteRepo] }
    const previousKey = getRuntimeMobileSessionSyncKey(before)
    expect(buildMobileSessionTabSnapshots(before)[0].tabs).toHaveLength(1)
    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before)).toBe(false)
    expect(
      runtimeMobileSessionSyncKeysEqual(
        previousKey,
        getRuntimeMobileSessionSyncKey(after, before, previousKey)
      )
    ).toBe(false)
    expect(buildMobileSessionTabSnapshots(after)).toEqual([])
  })

  it('does not publish a stamped remote file before the catalog hydrates', () => {
    const state = makeGraphState({ openFiles: [{ ...file, runtimeEnvironmentId: 'pro' }] })
    expect(buildMobileSessionTabSnapshots(state).flatMap((s) => s.tabs)).toEqual([])
  })

  it.each(['local', 'ssh:server'] as const)('preserves %s file publication', (executionHostId) => {
    const state = makeGraphState({
      repos: [{ ...remoteRepo, executionHostId }],
      openFiles: [file]
    })
    expect(buildMobileSessionTabSnapshots(state)[0].tabs).toMatchObject([
      { type: 'markdown', filePath: file.filePath }
    ])
  })

  it('rejects an older peer echo without changing the file owner or adding duplicate tabs', () => {
    const state = { ...makeState(), repos: [remoteRepo] }
    const patch = applyWebSessionTabsSnapshot(state, snapshot, 'pro')
    const mirrored = { ...state, ...patch }
    const echoed = applyWebSessionTabsSnapshot(mirrored, snapshot, 'mini')
    expect(echoed).toBe(mirrored)
    expect(echoed.openFiles).toHaveLength(1)
    expect(echoed.openFiles?.[0].runtimeEnvironmentId).toBe('pro')
  })

  it('applies the same ownership boundary to folder workspaces', () => {
    const folderId = 'folder:remote-folder'
    const folderWorkspaces = [
      {
        id: 'remote-folder',
        projectGroupId: 'group',
        name: 'folder',
        folderPath: '/worktree',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0,
        executionHostId: 'runtime:pro' as const
      }
    ]
    const state = { ...makeState(), folderWorkspaces }
    const folderSnapshot = { ...snapshot, worktree: folderId }
    expect(applyWebSessionTabsSnapshot(state, folderSnapshot, 'mini')).toBe(state)
    expect(
      buildMobileSessionTabSnapshots(
        makeGraphState({
          folderWorkspaces: folderWorkspaces as AppState['folderWorkspaces'],
          openFiles: [{ ...file, worktreeId: folderId }]
        })
      )
    ).toEqual([])
  })
})
