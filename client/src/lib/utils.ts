import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function riskLabel(score: number): string {
  if (score <= 30) return 'LOW'
  if (score <= 60) return 'MED'
  return 'HIGH'
}

export function riskColor(score: number): string {
  if (score <= 30) return 'text-green-400'
  if (score <= 60) return 'text-yellow-400'
  return 'text-red-400'
}
