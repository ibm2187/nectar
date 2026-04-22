import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: vi.fn().mockResolvedValue([]) }
})

vi.mock('../../../stores/availabilityStore', () => ({
  useAvailabilityStore: (selector: (s: { load: () => void; data: unknown }) => unknown) =>
    selector({ load: () => {}, data: { loaded: false, currentlyOut: [], upcomingHolidays: [], todayIsHoliday: null, lastRefreshedAt: null } }),
}))

vi.mock('../../../components/SavedViews', () => ({
  SavedViews: () => null,
}))

import { ReleasesPage } from '../ReleasesPage'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location-search">{loc.search}</div>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ReleasesPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText(/Loading releases/i)).not.toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ReleasesPage zoom toggle', () => {
  it('Week button sets zoom=week in the URL (Calendar view)', async () => {
    renderAt('/releases?view=calendar')
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))

    const search = screen.getByTestId('location-search').textContent || ''
    const params = new URLSearchParams(search)
    expect(params.get('zoom')).toBe('week')
  })

  it('Month button sets zoom=month (Calendar view)', async () => {
    renderAt('/releases?view=calendar')
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Month' }))

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent || '')
    expect(params.get('zoom')).toBe('month')
  })

  it('Day button sets zoom=day (Calendar view)', async () => {
    renderAt('/releases?view=calendar&zoom=month')
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Day' }))

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent || '')
    expect(params.get('zoom')).toBe('day')
  })

  it('Week button sets zoom=week in Agenda view', async () => {
    renderAt('/releases?view=agenda')
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent || '')
    expect(params.get('zoom')).toBe('week')
  })

  it('Agenda-view Week button is not highlighted when zoom is month (it is a Day/Week toggle only)', async () => {
    renderAt('/releases?view=agenda&zoom=month')
    await waitForLoaded()

    const weekButton = screen.getByRole('button', { name: 'Week' })
    expect(weekButton.className).not.toMatch(/bg-primary\b/)
  })
})
