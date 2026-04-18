import { useEffect, useState } from 'react'
import { apiFetch } from '../api/client'
import type { Customer } from '../api/client'

const ALL_CUSTOMERS_COLOR = '#e2e8f0'

/**
 * Shared fetch cache. The in-flight promise prevents duplicate requests
 * when multiple components mount before the first fetch completes.
 */
let cachedCustomers: Customer[] | null = null
let inflight: Promise<Customer[]> | null = null

export function useCustomers() {
  const [customers, setCustomers] = useState<Customer[]>(cachedCustomers || [])
  const [loading, setLoading] = useState(!cachedCustomers)

  useEffect(() => {
    if (cachedCustomers) return
    if (!inflight) {
      inflight = apiFetch<Customer[]>('/customers').then(data => {
        cachedCustomers = data
        inflight = null
        return data
      })
    }
    inflight
      .then(data => setCustomers(data))
      .finally(() => setLoading(false))
  }, [])

  return { customers, loading }
}

/** Build a lookup map from customer ID to customer record. */
export function buildCustomerMap(customers: Customer[]): Map<string, Customer> {
  return new Map(customers.map(c => [c.id, c]))
}

export { ALL_CUSTOMERS_COLOR }
