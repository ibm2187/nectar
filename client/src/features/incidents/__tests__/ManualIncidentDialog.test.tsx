import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const apiFetchMock = vi.fn()
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) }
})

import { ManualIncidentDialog } from '../ManualIncidentDialog'

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('ManualIncidentDialog', () => {
  it('submits the form with all filled fields', async () => {
    const onCreated = vi.fn()
    const onClose = vi.fn()
    apiFetchMock.mockResolvedValue({ id: 'inc-new' })

    render(<ManualIncidentDialog onClose={onClose} onCreated={onCreated} />)

    fireEvent.change(screen.getByPlaceholderText(/Slow page loads/i), {
      target: { value: 'Cache latency spike' },
    })
    fireEvent.change(screen.getByPlaceholderText(/bayada$/i), {
      target: { value: 'bayada' },
    })
    fireEvent.change(screen.getByPlaceholderText(/bayada-prod/i), {
      target: { value: 'bayada-prod' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Create Incident/i }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('inc-new'))
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/alerts/incidents',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.summary).toBe('Cache latency spike')
    expect(body.customerId).toBe('bayada')
    expect(body.envId).toBe('bayada-prod')
  })

  it('disables submit when summary is empty', () => {
    render(<ManualIncidentDialog onClose={() => {}} onCreated={() => {}} />)
    const submit = screen.getByRole('button', { name: /Create Incident/i })
    expect(submit).toBeDisabled()
  })

  it('surfaces server error on failed submit', async () => {
    apiFetchMock.mockRejectedValue(new Error('Backend exploded'))
    render(<ManualIncidentDialog onClose={() => {}} onCreated={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText(/Slow page loads/i), {
      target: { value: 'Something broke' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Create Incident/i }))

    await waitFor(() => expect(screen.getByText(/Backend exploded/i)).toBeInTheDocument())
  })

  it('cancel button calls onClose', () => {
    const onClose = vi.fn()
    render(<ManualIncidentDialog onClose={onClose} onCreated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
