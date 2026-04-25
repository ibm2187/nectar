import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { JiraHoverCard } from '../JiraHoverCard'

const ORIGINAL_FETCH = globalThis.fetch

function mockFetch(response: any, { ok = true, status = 200 } = {}) {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    status,
    json: async () => response,
  }) as any) as any
}

describe('JiraHoverCard', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('renders the wrapped JiraLink without fetching', () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
    render(<JiraHoverCard jiraKey="DEV-1" />)
    expect(screen.getByText('DEV-1')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches once on hover and renders ticket rows by enriched id', async () => {
    // Server returns enriched ticket rows with `id`, NOT `zohoTicketId`.
    // The previous implementation keyed off the wrong field, producing
    // `key={undefined}` and React duplicate-key warnings.
    mockFetch({
      jiraKey: 'DEV-1',
      tickets: [
        { id: 'z1', ticketNumber: 'VHC-100', subject: 'Payroll bug', accountName: 'CK', statusType: 'Open', status: 'Investigating', webUrl: null, ageDays: 12 },
        { id: 'z2', ticketNumber: 'VHC-101', subject: 'Timesheet', accountName: 'BYD', statusType: 'On Hold', status: 'WVR', webUrl: null, ageDays: 30 },
      ],
    })
    const wrapper = render(<JiraHoverCard jiraKey="DEV-1" />)
    fireEvent.mouseEnter(wrapper.container.querySelector('span')!)

    await waitFor(() => {
      expect(screen.getByText('VHC-100')).toBeInTheDocument()
      expect(screen.getByText('VHC-101')).toBeInTheDocument()
    }, { timeout: 1500 })

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain('/api/support/jira/DEV-1/links')
    expect(screen.getByText(/2 linked support tickets/)).toBeInTheDocument()
  })

  it('shows the empty-state when no tickets are linked', async () => {
    mockFetch({ jiraKey: 'DEV-2', tickets: [] })
    const wrapper = render(<JiraHoverCard jiraKey="DEV-2" />)
    fireEvent.mouseEnter(wrapper.container.querySelector('span')!)
    await waitFor(() => {
      expect(screen.getByText(/no linked Zoho support tickets/i)).toBeInTheDocument()
    }, { timeout: 1500 })
  })

  it('does not refetch on a second hover after a successful response', async () => {
    mockFetch({ jiraKey: 'DEV-3', tickets: [{ id: 'z1', ticketNumber: 'VHC-1', subject: 's', statusType: 'Open', status: null, accountName: null, webUrl: null, ageDays: 1 }] })
    const wrapper = render(<JiraHoverCard jiraKey="DEV-3" />)
    const anchor = wrapper.container.querySelector('span')!
    fireEvent.mouseEnter(anchor)
    await waitFor(() => expect(screen.getByText('VHC-1')).toBeInTheDocument(), { timeout: 1500 })

    fireEvent.mouseLeave(anchor)
    await new Promise(r => setTimeout(r, 150))
    fireEvent.mouseEnter(anchor)
    await new Promise(r => setTimeout(r, 300))

    // Cache hit — only one network call total.
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('retries on next hover if the first response failed', async () => {
    // First hover: 500 → no cache marker → second hover should refetch.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [{ id: 'z9', ticketNumber: 'VHC-9', subject: 'x', statusType: 'Open', status: null, accountName: null, webUrl: null, ageDays: 1 }] }) } as any) as any

    const wrapper = render(<JiraHoverCard jiraKey="DEV-4" />)
    const anchor = wrapper.container.querySelector('span')!
    fireEvent.mouseEnter(anchor)
    // Wait for first fetch to resolve (5xx)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce(), { timeout: 1500 })
    fireEvent.mouseLeave(anchor)
    await new Promise(r => setTimeout(r, 150))
    fireEvent.mouseEnter(anchor)

    await waitFor(() => expect(screen.getByText('VHC-9')).toBeInTheDocument(), { timeout: 1500 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})
