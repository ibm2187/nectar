import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

interface SavedView {
  name: string
  params: string
}

interface SavedViewsProps {
  storageKey: string
}

export function SavedViews({ storageKey }: SavedViewsProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [views, setViews] = useState<SavedView[]>([])
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Load saved views from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) setViews(JSON.parse(raw))
    } catch { /* ignore bad data */ }
  }, [storageKey])

  function persist(next: SavedView[]) {
    setViews(next)
    localStorage.setItem(storageKey, JSON.stringify(next))
  }

  function saveCurrentView() {
    if (!name.trim()) return
    const entry: SavedView = { name: name.trim(), params: searchParams.toString() }
    persist([...views.filter(v => v.name !== entry.name), entry])
    setName('')
    setNaming(false)
  }

  function applyView(view: SavedView) {
    setSearchParams(new URLSearchParams(view.params), { replace: true })
    setOpen(false)
  }

  function deleteView(viewName: string) {
    persist(views.filter(v => v.name !== viewName))
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setNaming(false)
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => { setOpen(!open); setNaming(false) }}
        className="text-xs h-7"
      >
        Views{views.length > 0 && ` (${views.length})`}
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-md border bg-popover shadow-md p-2 space-y-1">
          {views.length === 0 && !naming && (
            <p className="text-xs text-muted-foreground px-2 py-1">No saved views yet.</p>
          )}

          {views.map(v => (
            <div
              key={v.name}
              className="flex items-center gap-1 group"
            >
              <button
                type="button"
                onClick={() => applyView(v)}
                className="flex-1 text-left text-xs px-2 py-1.5 rounded hover:bg-accent truncate"
                title={v.name}
              >
                {v.name}
              </button>
              <button
                type="button"
                onClick={() => deleteView(v.name)}
                className="text-muted-foreground hover:text-destructive text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete"
              >
                x
              </button>
            </div>
          ))}

          {naming ? (
            <div className="flex items-center gap-1 pt-1 border-t">
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveCurrentView(); if (e.key === 'Escape') setNaming(false) }}
                placeholder="View name..."
                className="flex-1 text-xs px-2 py-1 rounded border bg-background"
                autoFocus
              />
              <Button variant="ghost" size="sm" onClick={saveCurrentView} className="text-xs h-6 px-2">
                Save
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNaming(true)}
              className={cn(
                "w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent text-muted-foreground",
                views.length > 0 && "border-t pt-2 mt-1"
              )}
            >
              + Save current view
            </button>
          )}
        </div>
      )}
    </div>
  )
}
