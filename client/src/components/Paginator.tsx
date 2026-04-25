import { Button } from './ui/button'
import { cn } from '../lib/utils'

/**
 * Paginator — shared "Showing N–M of T" + Prev/Next + page-size selector.
 *
 * Pairs with backends that return the standard `{ items, total, page, pageSize }`
 * envelope. Renders nothing when total <= pageSize (no pagination needed).
 */
export interface PaginatorProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizeOptions?: number[]
  className?: string
}

export function Paginator({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 200],
  className,
}: PaginatorProps) {
  if (total === 0 || (total <= pageSize && page === 1)) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)

  return (
    <div className={cn('flex items-center justify-between gap-3 flex-wrap text-xs', className)}>
      <div className="text-muted-foreground">
        Showing <strong className="text-foreground">{start.toLocaleString()}</strong>
        {' – '}
        <strong className="text-foreground">{end.toLocaleString()}</strong>
        {' of '}
        <strong className="text-foreground">{total.toLocaleString()}</strong>
      </div>
      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <label className="flex items-center gap-1 text-muted-foreground">
            Page size:
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-7 px-1.5 rounded border bg-background text-xs"
            >
              {pageSizeOptions.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="h-7 px-2 text-xs"
        >
          Prev
        </Button>
        <span className="text-muted-foreground tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="h-7 px-2 text-xs"
        >
          Next
        </Button>
      </div>
    </div>
  )
}
