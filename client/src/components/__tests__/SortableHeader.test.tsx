import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react'
import {
  SortableHeader,
  useSortableData,
  useSortState,
  nextSortState,
  type SortState,
} from '../SortableHeader'

// ── nextSortState pure logic ──────────────────────────

describe('nextSortState', () => {
  it('cycles natural → asc → desc → natural for the same key', () => {
    let state: SortState = { key: null, dir: null }
    state = nextSortState(state, 'name')
    expect(state).toEqual({ key: 'name', dir: 'asc' })

    state = nextSortState(state, 'name')
    expect(state).toEqual({ key: 'name', dir: 'desc' })

    state = nextSortState(state, 'name')
    expect(state).toEqual({ key: null, dir: null })
  })

  it('jumps to asc when clicking a different key', () => {
    const state: SortState = { key: 'name', dir: 'desc' }
    expect(nextSortState(state, 'date')).toEqual({ key: 'date', dir: 'asc' })
  })

  it('starts at asc when current is null', () => {
    expect(nextSortState({ key: null, dir: null }, 'x')).toEqual({ key: 'x', dir: 'asc' })
  })
})

// ── SortableHeader rendering ──────────────────────────

describe('<SortableHeader />', () => {
  function setup(state: SortState = { key: null, dir: null }) {
    let captured: string | null = null
    function Wrapper() {
      return (
        <table>
          <thead>
            <tr>
              <SortableHeader label="Name" sortKey="name" state={state} onSort={k => { captured = k }} />
            </tr>
          </thead>
        </table>
      )
    }
    render(<Wrapper />)
    return {
      get captured() { return captured },
      th: () => screen.getByText('Name').closest('th')!,
    }
  }

  it('renders the label', () => {
    setup()
    expect(screen.getByText('Name')).toBeDefined()
  })

  it('shows the inactive sort indicator (⇅) when not the active key', () => {
    setup({ key: 'other', dir: 'asc' })
    expect(screen.getByText('⇅')).toBeDefined()
  })

  it('shows ↑ when active key with asc direction', () => {
    setup({ key: 'name', dir: 'asc' })
    expect(screen.getByText('↑')).toBeDefined()
  })

  it('shows ↓ when active key with desc direction', () => {
    setup({ key: 'name', dir: 'desc' })
    expect(screen.getByText('↓')).toBeDefined()
  })

  it('shows ⇅ even when active key has dir=null', () => {
    setup({ key: 'name', dir: null })
    expect(screen.getByText('⇅')).toBeDefined()
  })

  it('calls onSort with the key when clicked', () => {
    const harness = setup()
    fireEvent.click(harness.th())
    expect(harness.captured).toBe('name')
  })
})

// ── useSortableData hook ──────────────────────────────

describe('useSortableData', () => {
  type Item = { name: string; age: number | null; createdAt: string }
  const items: Item[] = [
    { name: 'Charlie', age: 30, createdAt: '2026-03-01' },
    { name: 'alice',   age: 25, createdAt: '2026-01-01' },
    { name: 'Bob',     age: null, createdAt: '2026-02-01' },
  ]
  const accessors = {
    name:      (i: Item) => i.name,
    age:       (i: Item) => i.age,
    createdAt: (i: Item) => i.createdAt,
  }

  it('returns items in original order when state.dir is null', () => {
    const { result } = renderHook(() => useSortableData(items, { key: null, dir: null }, accessors))
    expect(result.current.map(i => i.name)).toEqual(['Charlie', 'alice', 'Bob'])
  })

  it('returns items in original order when key is null even if dir is set', () => {
    const { result } = renderHook(() => useSortableData(items, { key: null, dir: 'asc' }, accessors))
    expect(result.current).toBe(items) // identity preserved
  })

  it('sorts strings ascending case-insensitively', () => {
    const { result } = renderHook(() => useSortableData(items, { key: 'name', dir: 'asc' }, accessors))
    expect(result.current.map(i => i.name)).toEqual(['alice', 'Bob', 'Charlie'])
  })

  it('sorts strings descending', () => {
    const { result } = renderHook(() => useSortableData(items, { key: 'name', dir: 'desc' }, accessors))
    expect(result.current.map(i => i.name)).toEqual(['Charlie', 'Bob', 'alice'])
  })

  it('sorts numbers ascending', () => {
    const { result } = renderHook(() => useSortableData(items, { key: 'age', dir: 'asc' }, accessors))
    expect(result.current.map(i => i.age)).toEqual([25, 30, null]) // null sorts last
  })

  it('sorts numbers descending with nulls still last', () => {
    const { result } = renderHook(() => useSortableData(items, { key: 'age', dir: 'desc' }, accessors))
    expect(result.current.map(i => i.age)).toEqual([30, 25, null])
  })

  it('sorts dates ascending', () => {
    const { result } = renderHook(() => useSortableData(items, { key: 'createdAt', dir: 'asc' }, accessors))
    expect(result.current.map(i => i.createdAt)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
  })

  it('does not mutate the input array', () => {
    const original = [...items]
    renderHook(() => useSortableData(items, { key: 'name', dir: 'asc' }, accessors))
    expect(items).toEqual(original)
  })

  it('handles unknown sort key by returning items unchanged', () => {
    const { result } = renderHook(() => useSortableData(items, { key: 'bogus' as any, dir: 'asc' }, accessors as any))
    expect(result.current.map(i => i.name)).toEqual(['Charlie', 'alice', 'Bob'])
  })

  it('handles numeric strings naturally (DEV-2 before DEV-10)', () => {
    const naturalItems = [
      { name: 'DEV-10' },
      { name: 'DEV-2' },
      { name: 'DEV-1' },
    ]
    const { result } = renderHook(() =>
      useSortableData(naturalItems, { key: 'name', dir: 'asc' }, { name: i => i.name })
    )
    expect(result.current.map(i => i.name)).toEqual(['DEV-1', 'DEV-2', 'DEV-10'])
  })
})

// ── useSortState hook ─────────────────────────────────

describe('useSortState', () => {
  it('starts with the initial state', () => {
    const { result } = renderHook(() => useSortState<'name' | 'age'>('name', 'desc'))
    expect(result.current[0]).toEqual({ key: 'name', dir: 'desc' })
  })

  it('starts with null when no defaults', () => {
    const { result } = renderHook(() => useSortState<'name'>())
    expect(result.current[0]).toEqual({ key: null, dir: null })
  })

  it('cycles through states on repeated clicks', () => {
    const { result } = renderHook(() => useSortState<'name'>())

    act(() => result.current[1]('name'))
    expect(result.current[0]).toEqual({ key: 'name', dir: 'asc' })

    act(() => result.current[1]('name'))
    expect(result.current[0]).toEqual({ key: 'name', dir: 'desc' })

    act(() => result.current[1]('name'))
    expect(result.current[0]).toEqual({ key: null, dir: null })

    act(() => result.current[1]('name'))
    expect(result.current[0]).toEqual({ key: 'name', dir: 'asc' })
  })

  it('switches keys to asc', () => {
    const { result } = renderHook(() => useSortState<'name' | 'age'>('name', 'desc'))
    act(() => result.current[1]('age'))
    expect(result.current[0]).toEqual({ key: 'age', dir: 'asc' })
  })
})
