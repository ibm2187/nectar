import { useState } from 'react'

interface CommitListProps {
  commits: Array<{ sha: string; message: string }>
}

export function CommitList({ commits }: CommitListProps) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? commits : commits.slice(0, 5)

  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        {commits.length} commit{commits.length !== 1 ? 's' : ''} since last success
      </h4>
      <div className="space-y-0.5">
        {visible.map(c => (
          <div key={c.sha} className="flex items-start gap-2 text-xs">
            <span className="font-mono text-muted-foreground shrink-0">{c.sha.slice(0, 7)}</span>
            <span className="truncate">{c.message}</span>
          </div>
        ))}
      </div>
      {commits.length > 5 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-primary hover:underline mt-1"
        >
          Show {commits.length - 5} more
        </button>
      )}
    </div>
  )
}
