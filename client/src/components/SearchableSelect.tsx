import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import { Input } from './ui/input'

/**
 * Single-select with search. Sibling of MultiSelectPopover — same look,
 * but clicking an item picks it and closes the panel.
 *
 * Use when the option set is too long to fit a native <select> comfortably
 * (e.g. Slack channels — a workspace can have hundreds).
 *
 * Uses bg-card (not bg-popover): bg-popover resolves transparent in this
 * theme; bg-card is guaranteed opaque.
 */
export interface SearchableSelectProps {
  items: { value: string; label: string; icon?: string }[]
  value: string | null
  onChange: (value: string | null) => void
  placeholder: string
  searchPlaceholder?: string
  /** Optional empty-state hint when items.length === 0. */
  emptyHint?: string
  /** When true, renders a "Clear" row that calls onChange(null). */
  clearable?: boolean
  disabled?: boolean
  className?: string
}

export function SearchableSelect({
  items,
  value,
  onChange,
  placeholder,
  searchPlaceholder = 'Search…',
  emptyHint,
  clearable = false,
  disabled = false,
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Reset the query whenever the panel re-opens so the user starts fresh.
  useEffect(() => { if (open) setQuery('') }, [open])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 200)
    return items.filter(i => i.label.toLowerCase().includes(q)).slice(0, 200)
  }, [items, query])

  const current = items.find(i => i.value === value)

  return (
    <div ref={wrapRef} className={cn('relative inline-block', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={cn(
          'w-full inline-flex items-center justify-between gap-1.5 px-2.5 py-1.5 text-sm rounded border bg-background transition-colors',
          'hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        <span className="truncate flex items-center gap-1.5">
          {current?.icon && <span>{current.icon}</span>}
          {current ? current.label : <span className="text-muted-foreground">{placeholder}</span>}
        </span>
        <span className="opacity-60 text-[10px] shrink-0">▾</span>
      </button>
      {open && (
        // bg-card (not bg-popover): bg-popover is undefined → transparent.
        <div className="absolute top-full left-0 mt-1 w-full min-w-[14rem] rounded-md border border-border bg-card text-card-foreground shadow-xl z-50">
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
          {clearable && value && (
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent border-b"
            >
              Clear
            </button>
          )}
          <div className="max-h-72 overflow-y-auto">
            {visible.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                {emptyHint || 'No matches.'}
              </div>
            )}
            {visible.map(i => (
              <button
                key={i.value}
                type="button"
                onClick={() => { onChange(i.value); setOpen(false) }}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center gap-1.5',
                  i.value === value && 'bg-accent/50 font-medium',
                )}
              >
                {i.icon && <span>{i.icon}</span>}
                <span className="flex-1 truncate">{i.label}</span>
                {i.value === value && <span className="text-[10px] text-primary">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
