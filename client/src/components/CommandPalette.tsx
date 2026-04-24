import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWsStore } from '../stores/wsStore'
import { apiFetch } from '../api/client'
import { cn } from '../lib/utils'

interface SearchResult {
  type: 'release' | 'ticket' | 'environment' | 'customer' | 'zoho'
  // Release fields
  version?: string
  repo?: string | null
  state?: string
  branch?: string | null
  // Ticket fields
  key?: string
  summary?: string
  jiraStatus?: string | null
  // Environment fields
  id?: string
  customerId?: string
  tier?: string | null
  currentVersion?: string | null
  // Customer fields
  name?: string
  // Zoho fields
  ticketNumber?: string
  subject?: string | null
  status?: string | null
  webUrl?: string | null
}

interface SearchResponse {
  query: string
  results: SearchResult[]
  total: number
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

const CATEGORY_ORDER = ['release', 'ticket', 'zoho', 'environment', 'customer'] as const
const CATEGORY_LABELS: Record<string, string> = {
  release: 'Releases',
  ticket: 'JIRA Tickets',
  zoho: 'Zoho Tickets',
  environment: 'Environments',
  customer: 'Customers',
}
const CATEGORY_ICONS: Record<string, string> = {
  release: '\u{1F4E6}',
  ticket: '\u{1F3AF}',
  zoho: '\u{1F6DF}', // 🛟
  environment: '\u{1F3E2}',
  customer: '\u{1F465}',
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const jiraBaseUrl = useWsStore(s => s.config.jiraBaseUrl)

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setActiveIndex(0)
      setLoading(false)
      // Focus input after render
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [open])

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await apiFetch<SearchResponse>(`/search?q=${encodeURIComponent(q)}`)
      setResults(data.results)
      setActiveIndex(0)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(value), 300)
  }, [doSearch])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Group results by category
  const grouped = CATEGORY_ORDER
    .map(type => ({
      type,
      label: CATEGORY_LABELS[type],
      icon: CATEGORY_ICONS[type],
      items: results.filter(r => r.type === type),
    }))
    .filter(g => g.items.length > 0)

  // Flat list for keyboard navigation
  const flatItems = grouped.flatMap(g => g.items)

  // Navigate to a result
  const handleSelect = useCallback((item: SearchResult) => {
    onClose()
    switch (item.type) {
      case 'release':
        navigate(`/releases/${item.version}`)
        break
      case 'ticket':
        if (jiraBaseUrl && item.key) {
          window.open(`${jiraBaseUrl}/browse/${item.key}`, '_blank')
        }
        break
      case 'zoho':
        if (item.webUrl) {
          window.open(item.webUrl, '_blank')
        }
        break
      case 'environment':
        navigate(`/environments/${item.id}`)
        break
      case 'customer':
        navigate(`/health/${item.id}`)
        break
    }
  }, [navigate, jiraBaseUrl, onClose])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(prev => Math.min(prev + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flatItems[activeIndex]) {
        handleSelect(flatItems[activeIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [flatItems, activeIndex, handleSelect, onClose])

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const active = listRef.current.querySelector('[data-active="true"]')
    if (active) {
      active.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex])

  if (!open) return null

  // Track flat index across grouped render
  let flatIndex = 0

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="fixed left-1/2 top-[15%] z-50 w-[95vw] max-w-2xl -translate-x-1/2 rounded-xl border border-border/60 bg-card shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
          <svg
            className="w-5 h-5 text-muted-foreground shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search releases, tickets, environments..."
            className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/60 text-foreground"
          />
          {loading && (
            <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {query.length >= 2 && !loading && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results found for "{query}"
            </div>
          )}

          {query.length === 1 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Type at least 2 characters to search
            </div>
          )}

          {grouped.map(group => (
            <div key={group.type}>
              <div className="px-5 py-2 text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
                {group.label}
              </div>
              {group.items.map(item => {
                const idx = flatIndex++
                const isActive = idx === activeIndex
                return (
                  <button
                    key={`${item.type}-${item.version || item.key || item.id}`}
                    data-active={isActive}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      "w-full flex items-center gap-3 px-5 py-3 text-sm text-left transition-colors",
                      isActive ? "bg-primary/10 text-foreground" : "text-foreground/80 hover:bg-accent/40"
                    )}
                  >
                    <span className="shrink-0 text-base">{CATEGORY_ICONS[item.type]}</span>
                    <ResultLabel item={item} />
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Footer with keyboard hints */}
        <div className="border-t px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span><kbd className="px-1 py-0.5 rounded bg-muted font-mono text-[10px]">&uarr;&darr;</kbd> Navigate</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted font-mono text-[10px]">Enter</kbd> Select</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted font-mono text-[10px]">Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  )
}

/** Renders the label line for a search result based on its type */
function ResultLabel({ item }: { item: SearchResult }) {
  switch (item.type) {
    case 'release':
      return (
        <span className="truncate">
          <span className="font-medium">{item.version}</span>
          {item.repo && <span className="text-muted-foreground"> &middot; {item.repo}</span>}
          {item.state && <span className="text-muted-foreground"> &middot; {item.state}</span>}
        </span>
      )
    case 'ticket':
      return (
        <span className="truncate">
          <span className="font-medium">{item.key}</span>
          {item.summary && <span className="text-muted-foreground"> &middot; {item.summary}</span>}
        </span>
      )
    case 'zoho':
      return (
        <span className="truncate">
          <span className="font-medium">{item.ticketNumber}</span>
          {item.subject && <span className="text-muted-foreground"> &middot; {item.subject}</span>}
          {item.status && <span className="text-muted-foreground/70"> &middot; {item.status}</span>}
        </span>
      )
    case 'environment':
      return (
        <span className="truncate">
          <span className="font-medium">{item.id}</span>
          {item.tier && <span className="text-muted-foreground"> &middot; {item.tier}</span>}
          {item.currentVersion && <span className="text-muted-foreground"> &middot; v{item.currentVersion}</span>}
        </span>
      )
    case 'customer':
      return (
        <span className="truncate">
          <span className="font-medium">{item.name || item.id}</span>
        </span>
      )
    default:
      return null
  }
}
