import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabGroup } from '../../../shared/tab-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

function emptyGroup(id: string): TabGroup {
  return { id, worktreeId: WT, tabOrder: [], activeTabId: null, recentTabIds: [] }
}

describe('empty runtime snapshots preserve client layout ownership', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps the last rendered group when the host removes its final terminal', () => {
    const initial = makeState()
    const ready = {
      ...initial,
      ...applyWebSessionTabsSnapshot(
        initial,
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            title: 'Terminal',
            status: 'ready',
            terminal: 'term_host',
            isActive: true
          }
        ]),
        ENV,
        NOW
      )
    }
    const groupId = ready.groupsByWorktree[WT][0].id
    const next = {
      ...ready,
      ...applyWebSessionTabsSnapshot(ready, makeSnapshot([]), ENV, NOW + 1)
    }
    expect(next.groupsByWorktree[WT]).toEqual([emptyGroup(groupId)])
    expect(next.layoutByWorktree[WT]).toEqual(ready.layoutByWorktree[WT])
    expect(next.activeGroupIdByWorktree[WT]).toBe(groupId)
    expect(next.unifiedTabsByWorktree[WT] ?? []).toEqual([])
  })

  it('keeps empty split groups and their selection across repeated empty snapshots', () => {
    const groups = [emptyGroup('left'), emptyGroup('right')]
    const initial = makeState({
      groupsByWorktree: { [WT]: groups },
      activeGroupIdByWorktree: { [WT]: 'right' },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'left' },
          second: { type: 'leaf', groupId: 'right' }
        }
      }
    })
    let current = initial
    for (let version = 1; version <= 3; version++) {
      current = {
        ...current,
        ...applyWebSessionTabsSnapshot(
          current,
          makeSnapshot([], { snapshotVersion: version }),
          ENV,
          NOW + version
        )
      }
      expect(current.groupsByWorktree[WT]).toEqual(groups)
      expect(current.layoutByWorktree[WT]).toEqual(initial.layoutByWorktree[WT])
      expect(current.activeGroupIdByWorktree[WT]).toBe('right')
    }
  })

  it('does not create a layout for a workspace that has never had tabs', () => {
    const initial = makeState()
    const next = { ...initial, ...applyWebSessionTabsSnapshot(initial, makeSnapshot([]), ENV, NOW) }
    expect(next.groupsByWorktree[WT]).toBeUndefined()
    expect(next.layoutByWorktree[WT]).toBeUndefined()
    expect(next.activeGroupIdByWorktree[WT]).toBeUndefined()
  })
})
