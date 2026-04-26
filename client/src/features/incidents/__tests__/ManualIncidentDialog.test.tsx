import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const apiFetchMock = vi.fn()
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) }
})

// Stub the lookup hooks to keep the dialog focused on its own behavior.
vi.mock('../../../lib/customer-utils', () => ({
  useCustomers: () => ({ customers: [], loading: false }),
}))
vi.mock('../../../stores/wsStore', () => ({
  useWsStore: () => [],
}))
vi.mock('../../../lib/use-basic-users', () => ({
  useBasicUsers: () => ({ users: [], loading: false }),
}))

import { ManualIncidentDialog } from '../ManualIncidentDialog'

beforeEach(() => {
  apiFetchMock.mockReset()
  // The dialog fires /alerts/slack/channels on mount. Default to empty.
  apiFetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/alerts/slack/channels')) {
      return Promise.resolve({ ok: true, channels: [] })
    }
    return Promise.resolve({ id: 'inc-new' })
  })
})

describe('ManualIncidentDialog', () => {
  it('submits the form with summary set', async () => {
    const onCreated = vi.fn()
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/alerts/slack/channels')) {
        return Promise.resolve({ ok: true, channels: [] })
      }
      return Promise.resolve({ id: 'inc-new' })
    })

    render(<ManualIncidentDialog onClose={() => {}} onCreated={onCreated} />)

    fireEvent.change(screen.getByPlaceholderText(/Slow page loads/i), {
      target: { value: 'Cache latency spike' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Create Incident/i }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('inc-new'))
    const createCall = apiFetchMock.mock.calls.find(c => c[0] === '/alerts/incidents')
    expect(createCall).toBeTruthy()
    const body = JSON.parse((createCall![1] as RequestInit).body as string)
    expect(body.summary).toBe('Cache latency spike')
  })

  it('disables submit when summary is empty', () => {
    render(<ManualIncidentDialog onClose={() => {}} onCreated={() => {}} />)
    const submit = screen.getByRole('button', { name: /Create Incident/i })
    expect(submit).toBeDisabled()
  })

  it('surfaces server error on failed submit', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/alerts/slack/channels')) {
        return Promise.resolve({ ok: true, channels: [] })
      }
      return Promise.reject(new Error('Backend exploded'))
    })
    render(<ManualIncidentDialog onClose={() => {}} onCreated={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText(/Slow page loads/i), {
      target: { value: 'Something broke' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Create Incident/i }))

    await waitFor(() => expect(screen.getByText(/Backend exploded/i)).toBeInTheDocument())
  })

  it('surfaces a Slack post failure inline (incident still created)', async () => {
    // Simulate the "bot not in channel" silent-fail-class that used to
    // leave incidents with no thread. Now the dialog shows it.
    const onCreated = vi.fn()
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/alerts/slack/channels')) {
        return Promise.resolve({
          ok: true,
          channels: [{ id: 'C1', name: 'alerts-prod', isPrivate: false }],
        })
      }
      return Promise.resolve({
        id: 'inc-new',
        slackPostResults: [{
          channel: '#alerts-prod', ok: false,
          error: 'Bot not in channel', code: 'not_in_channel',
        }],
      })
    })

    render(<ManualIncidentDialog onClose={() => {}} onCreated={onCreated} />)
    // The channel list loads asynchronously into the SearchableSelect's
    // hidden panel; we don't need to actually pick a channel — the mocked
    // response returns the failure regardless. Just submit and assert
    // the inline failure UI appears.
    fireEvent.change(screen.getByPlaceholderText(/Slow page loads/i), {
      target: { value: 'Slack channel typo case' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Create Incident/i }))

    await waitFor(() => expect(screen.getByText(/Slack post failed/i)).toBeInTheDocument())
    // onCreated should NOT auto-close — the user gets to read the failure.
    expect(onCreated).not.toHaveBeenCalled()
    // ...but the "Continue to incident" button can take them in.
    fireEvent.click(screen.getByRole('button', { name: /Continue to incident/i }))
    expect(onCreated).toHaveBeenCalledWith('inc-new')
  })

  it('cancel button calls onClose', () => {
    const onClose = vi.fn()
    render(<ManualIncidentDialog onClose={onClose} onCreated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
