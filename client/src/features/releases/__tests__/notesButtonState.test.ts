import { describe, it, expect } from 'vitest'

/**
 * Tests the condition logic for which notes button state to show.
 * Mirrors the ternary chain in ReleaseDetail.tsx.
 */

interface TaskArtifact {
  type: string
  filename: string
}

interface NotesTask {
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
  output: { notes?: string; artifacts?: TaskArtifact[] } | null
}

type ButtonState = 'loading' | 'completed-with-edit' | 'failed' | 'generate'

function getNotesButtonState(
  notesTaskLoading: boolean,
  notesTask: NotesTask | null,
): ButtonState {
  if (notesTaskLoading || (notesTask && (notesTask.status === 'pending' || notesTask.status === 'in-progress'))) {
    return 'loading'
  }
  if (notesTask && notesTask.status === 'completed' && (notesTask.output?.artifacts?.length || notesTask.output?.notes)) {
    return 'completed-with-edit'
  }
  if (notesTask && notesTask.status === 'failed') {
    return 'failed'
  }
  return 'generate'
}

describe('Notes button state logic', () => {
  it('shows loading when task is loading', () => {
    expect(getNotesButtonState(true, null)).toBe('loading')
  })

  it('shows loading when task is pending', () => {
    expect(getNotesButtonState(false, { status: 'pending', output: null })).toBe('loading')
  })

  it('shows loading when task is in-progress', () => {
    expect(getNotesButtonState(false, { status: 'in-progress', output: null })).toBe('loading')
  })

  it('shows completed-with-edit when task has artifacts', () => {
    expect(getNotesButtonState(false, {
      status: 'completed',
      output: { artifacts: [{ type: 'pdf', filename: 'release-notes.pdf' }] },
    })).toBe('completed-with-edit')
  })

  it('shows completed-with-edit when task has notes but no artifacts', () => {
    // This is the bug fix — previously this returned 'generate'
    expect(getNotesButtonState(false, {
      status: 'completed',
      output: { notes: '# Release notes content' },
    })).toBe('completed-with-edit')
  })

  it('shows completed-with-edit when task has both notes and artifacts', () => {
    expect(getNotesButtonState(false, {
      status: 'completed',
      output: {
        notes: '# Notes',
        artifacts: [{ type: 'draft', filename: 'release-notes-draft.md' }],
      },
    })).toBe('completed-with-edit')
  })

  it('shows generate when completed with empty output', () => {
    expect(getNotesButtonState(false, {
      status: 'completed',
      output: {},
    })).toBe('generate')
  })

  it('shows generate when completed with null output', () => {
    expect(getNotesButtonState(false, {
      status: 'completed',
      output: null,
    })).toBe('generate')
  })

  it('shows failed when task failed', () => {
    expect(getNotesButtonState(false, {
      status: 'failed',
      output: null,
    })).toBe('failed')
  })

  it('shows generate when no task exists', () => {
    expect(getNotesButtonState(false, null)).toBe('generate')
  })
})
