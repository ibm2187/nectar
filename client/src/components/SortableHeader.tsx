import { useState, useMemo } from 'react'
import { cn } from '../lib/utils'

// ── Types ─────────────────────────────────────────────

export type SortDir = 'asc' | 'desc' | null

export interface SortState<K extends string = string> {
  key: K | null
  dir: SortDir
}

/**
 * Cycle a sort state for a given key:
 *   not-sorted → asc → desc → not-sorted
 * If a different key is clicked, jump to asc on the new key.
 */
export function nextSortState<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  if (current.dir === 'desc') return { key: null, dir: null }
  return { key, dir: 'asc' }
}

// ── Sort indicator icon ───────────────────────────────

function SortIcon({ dir }: { dir: SortDir }) {
  // Tri-state visual: dim ⇅ when inactive, bold ↑/↓ when active
  if (dir === 'asc') return <span className="ml-1 text-foreground">↑</span>
  if (dir === 'desc') return <span className="ml-1 text-foreground">↓</span>
  return <span className="ml-1 text-muted-foreground/40">⇅</span>
}

// ── SortableHeader ────────────────────────────────────

export interface SortableHeaderProps {
  label: string
  sortKey: string
  state: SortState
  onSort: (key: string) => void
  className?: string
  align?: 'left' | 'center' | 'right'
  title?: string
}

export function SortableHeader({ label, sortKey, state, onSort, className, align = 'left', title }: SortableHeaderProps) {
  const isActive = state.key === sortKey
  const alignClass = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left'
  return (
    <th
      onClick={() => onSort(sortKey)}
      title={title}
      className={cn(
        'px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap',
        alignClass,
        className
      )}
    >
      <span className="inline-flex items-center">
        {label}
        <SortIcon dir={isActive ? state.dir : null} />
      </span>
    </th>
  )
}

// ── useSortableData hook ──────────────────────────────

/**
 * Comparator factory. Returns a comparator function for the given
 * sort state and field accessor map.
 *
 *   const sorted = useSortableData(items, sortState, {
 *     name: t => t.name,
 *     date: t => t.createdAt,
 *   })
 *
 * When state.dir is null, returns the original (natural) order.
 */
export type Accessor<T> = (item: T) => string | number | null | undefined
export type Accessors<T, K extends string> = Record<K, Accessor<T>>

export function useSortableData<T, K extends string>(
  items: T[],
  state: SortState<K>,
  accessors: Accessors<T, K>
): T[] {
  return useMemo(() => {
    if (!state.key || !state.dir) return items
    const accessor = accessors[state.key]
    if (!accessor) return items
    const dir = state.dir === 'asc' ? 1 : -1
    // Don't mutate input
    return [...items].sort((a, b) => compare(accessor(a), accessor(b), dir))
  }, [items, state.key, state.dir, accessors])
}

function compare(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  dir: 1 | -1,
): number {
  // Nullish values always sort last, regardless of direction
  const aNull = a === null || a === undefined || a === ''
  const bNull = b === null || b === undefined || b === ''
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  let cmp: number
  if (typeof a === 'number' && typeof b === 'number') cmp = a - b
  else cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  return cmp * dir
}

// ── useSortState hook ─────────────────────────────────

/**
 * Convenience hook to manage sort state with a default.
 * Returns [state, onSort] tuple.
 */
export function useSortState<K extends string>(initialKey: K | null = null, initialDir: SortDir = null): [SortState<K>, (key: K) => void] {
  const [state, setState] = useState<SortState<K>>({ key: initialKey, dir: initialDir })
  const onSort = (key: K) => setState(prev => nextSortState(prev, key))
  return [state, onSort]
}
