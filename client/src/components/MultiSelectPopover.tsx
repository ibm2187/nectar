import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import { Input } from './ui/input'

/**
 * Multi-select popover — button with searchable, scrollable checkbox list.
 *
 * For filters with too many options to render as inline chips (Accounts,
 * Releases). Keeps the selected state visible on the trigger and uses an
 * opaque `bg-card` panel (the theme's `--popover` token is undefined and
 * resolves transparent — verified empirically; see AlertRulesPanel comment).
 */
export interface MultiSelectPopoverProps {
  items: { id: string; label: string }[]
  selected: string[]
  onChange: (ids: string[]) => void
  /** Trigger label when nothing is selected, e.g. "All accounts" */
  placeholder: string
  searchPlaceholder: string
  /** Plural noun for the button label when 2+ are selected, e.g. "accounts" */
  noun: string
  triggerWidth?: string
  panelWidth?: string
}

export function MultiSelectPopover({
  items,
  selected,
  onChange,
  placeholder,
  searchPlaceholder,
  noun,
  triggerWidth = '14rem',
  panelWidth = '18rem',
}: MultiSelectPopoverProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selectedSet = new Set(selected)

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 300)
    return items.filter(i => i.label.toLowerCase().includes(q)).slice(0, 300)
  }, [items, query])

  const orderedItems = useMemo(() => {
    if (query.trim()) return visibleItems
    const sel: typeof items = []
    const rest: typeof items = []
    for (const i of visibleItems) (selectedSet.has(i.id) ? sel : rest).push(i)
    return [...sel, ...rest]
  }, [visibleItems, query, selectedSet])

  const toggle = (id: string) => {
    onChange(selectedSet.has(id) ? selected.filter(x => x !== id) : [...selected, id])
  }

  const buttonLabel =
    selected.length === 0 ? placeholder :
    selected.length === 1 ? (items.find(i => i.id === selected[0])?.label || selected[0]) :
    `${selected.length} ${noun}`

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors',
          selected.length > 0
            ? 'bg-primary/10 border-primary/40 text-primary'
            : 'bg-background hover:bg-muted border-muted-foreground/30'
        )}
        style={{ maxWidth: triggerWidth }}
      >
        <span className="truncate" style={{ maxWidth: `calc(${triggerWidth} - 1rem)` }}>{buttonLabel}</span>
        <span className="opacity-60 text-[10px]">▾</span>
      </button>
      {open && (
        // bg-card (not bg-popover): bg-popover resolves to a transparent var in this theme.
        <div
          className="absolute top-full left-0 mt-1 rounded-md border border-border bg-card text-card-foreground shadow-xl z-50"
          style={{ width: panelWidth }}
        >
          <div className="p-2 border-b">
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-7 text-xs"
              autoFocus
            />
          </div>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent border-b"
            >
              Clear all ({selected.length})
            </button>
          )}
          <div className="max-h-72 overflow-y-auto">
            {orderedItems.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                No matches.
              </div>
            )}
            {orderedItems.map(i => (
              <label
                key={i.id}
                className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedSet.has(i.id)}
                  onChange={() => toggle(i.id)}
                  className="h-3.5 w-3.5"
                />
                <span className="flex-1 truncate">{i.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
