import { wslGatedReaddir, wslGatedReadFileBounded } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { join } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  seedFullFirstUserPrompt,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { extractFullFirstUserPromptText } from './session-scanner-first-user-prompt'
import {
  asRecord,
  extractPreviewContentText,
  extractString,
  findOpenCodeStorageRoot,
  normalizeTitleText,
  timeObjectValue,
  timestampMs,
  tokenTotal
} from './session-scanner-values'

// Why: OpenCode embeds snapshots and diffs inside single message JSONs, so a
// long session can grow one file to hundreds of MB; the vault needs its
// listing fields, not the blob. Same story for the session record itself.
const OPENCODE_FILE_SCAN_BOUND_BYTES = 16 * 1024 * 1024
// Bounds the retained pre-sort message array: thousands of small files must
// not sum past the per-file bound's protection.
const OPENCODE_MESSAGE_DIR_SCAN_BOUND_BYTES = 64 * 1024 * 1024

export async function parseOpenCodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const raw = await wslGatedReadFileBounded(
    file.path,
    'utf-8',
    OPENCODE_FILE_SCAN_BOUND_BYTES,
    'scan'
  )
  if (raw === null) {
    // Thrown, not returned: an oversized session record is a scan issue the
    // panel should show (the session is unlistable), not a silent absence.
    throw new Error(
      `OpenCode session file exceeds the ${OPENCODE_FILE_SCAN_BOUND_BYTES / (1024 * 1024)}MB scan bound: ${file.path}`
    )
  }
  const record = asRecord(JSON.parse(raw) as unknown)
  if (!record) {
    return null
  }
  const sessionId = extractString(record.id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'opencode', file, sessionId })
  accumulator.title = normalizeTitleText(extractString(record.title) ?? '')
  accumulator.cwd = extractString(record.directory)
  updateTimeline(accumulator, timeObjectValue(record.time, 'created'))
  updateTimeline(accumulator, timeObjectValue(record.time, 'updated'))
  await consumeOpenCodeMessages(accumulator, findOpenCodeStorageRoot(file.path), sessionId)
  return finalizeSession(accumulator, platform)
}

// Why: OpenCode stores one file per message and `readdir` order is arbitrary,
// so the transcript has to be rebuilt by creation time before anything reads
// "the first user prompt". Undated messages sort last, by file name, so a
// missing timestamp can never displace a real first turn.
async function readOpenCodeMessagesInOrder(messageDir: string): Promise<Record<string, unknown>[]> {
  let entries
  try {
    entries = await wslGatedReaddir(messageDir, 'scan')
  } catch (error) {
    // A session with no message dir yet is empty; a gate refusal is not — an
    // empty transcript would otherwise be cached under the session's mtime.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return []
  }
  const messages: { name: string; createdMs: number; message: Record<string, unknown> }[] = []
  let bytesConsumed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    if (bytesConsumed >= OPENCODE_MESSAGE_DIR_SCAN_BOUND_BYTES) {
      break
    }
    let message: Record<string, unknown> | null = null
    try {
      const raw = await wslGatedReadFileBounded(
        join(messageDir, entry.name),
        'utf-8',
        OPENCODE_FILE_SCAN_BOUND_BYTES,
        'scan'
      )
      // Oversized joins half-written files in the skip bucket: one bloated
      // message must not cost the session its listing.
      if (raw !== null) {
        bytesConsumed += raw.length
        message = asRecord(JSON.parse(raw) as unknown)
      }
    } catch (error) {
      // A live OpenCode process can leave a half-written file; skip it rather
      // than discard the whole session. A refused read is not a bad file — the
      // partial transcript it would produce must not become the cached answer.
      if (error instanceof WslTranscriptFsError) {
        throw error
      }
      continue
    }
    if (!message) {
      continue
    }
    const createdMs = timestampMs(timeObjectValue(message.time, 'created'))
    messages.push({
      name: entry.name,
      createdMs: Number.isFinite(createdMs) ? createdMs : Number.POSITIVE_INFINITY,
      message
    })
  }
  return messages
    .sort((a, b) => a.createdMs - b.createdMs || a.name.localeCompare(b.name))
    .map((entry) => entry.message)
}

export async function consumeOpenCodeMessages(
  accumulator: SessionAccumulator,
  storageRoot: string | null,
  sessionId: string
): Promise<void> {
  if (!storageRoot) {
    return
  }
  for (const message of await readOpenCodeMessagesInOrder(
    join(storageRoot, 'message', sessionId)
  )) {
    const role = extractString(message.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      updateTimeline(accumulator, timeObjectValue(message.time, 'created'))
      const summary = asRecord(message.summary)
      if (role === 'user') {
        accumulator.title ??= extractString(summary?.title) ?? extractString(summary?.body)
      }
      // Why: the summary fallbacks are AI-generated. Seed the copyable first
      // prompt from real typed content only, never from a summary of a
      // harness-injected turn. Extraction stays inside the thunk so list scans
      // (capture mode `none`) never pay for it.
      seedFullFirstUserPrompt(accumulator, role, () =>
        extractFullFirstUserPromptText(message.content)
      )
      addPreviewMessage(accumulator, {
        role,
        text:
          extractPreviewContentText(message.content) ??
          extractString(summary?.body) ??
          extractString(summary?.title),
        timestamp: timeObjectValue(message.time, 'created'),
        seedFirstUserPrompt: false
      })
      accumulator.model =
        extractString(asRecord(message.model)?.modelID) ||
        extractString(message.modelID) ||
        accumulator.model
      accumulator.totalTokens += tokenTotal(message.tokens)
    }
  }
}
