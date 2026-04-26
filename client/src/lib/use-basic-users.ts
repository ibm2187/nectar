import { useEffect, useState } from 'react'
import { apiFetch } from '../api/client'

export interface BasicUser {
  email: string
  name: string | null
  picture: string | null
}

/**
 * Lightweight directory of known users — fetches /api/users/basic which is
 * not capability-gated (unlike /api/access/users).
 *
 * Module-level in-flight + cache so multiple components mounting in the
 * same session don't each fire the request.
 */
let cached: BasicUser[] | null = null
let inflight: Promise<BasicUser[]> | null = null

export function useBasicUsers() {
  const [users, setUsers] = useState<BasicUser[]>(cached ?? [])
  const [loading, setLoading] = useState(!cached)

  useEffect(() => {
    if (cached) return
    if (!inflight) {
      inflight = apiFetch<BasicUser[]>('/users/basic').then(data => {
        cached = data
        inflight = null
        return data
      })
    }
    inflight.then(data => setUsers(data)).finally(() => setLoading(false))
  }, [])

  return { users, loading }
}
