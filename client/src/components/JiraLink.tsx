import { useWsStore } from '../stores/wsStore'
import { cn } from '../lib/utils'

interface JiraLinkProps {
  jiraKey: string
  className?: string
  children?: React.ReactNode
}

/**
 * Renders a JIRA ticket key as a clickable link to the JIRA issue.
 * Falls back to plain text if jiraBaseUrl isn't configured.
 */
export function JiraLink({ jiraKey, className, children }: JiraLinkProps) {
  const jiraBaseUrl = useWsStore(s => s.config.jiraBaseUrl)

  if (!jiraBaseUrl) {
    return <span className={cn("font-mono font-semibold", className)}>{children || jiraKey}</span>
  }

  return (
    <a
      href={`${jiraBaseUrl}/browse/${jiraKey}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("font-mono font-semibold text-primary hover:underline", className)}
      title={`Open ${jiraKey} in JIRA`}
    >
      {children || jiraKey}
    </a>
  )
}
