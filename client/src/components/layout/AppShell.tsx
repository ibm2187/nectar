import { useState, useCallback, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { ConnectionBanner } from './ConnectionBanner'
import { CommandPalette } from '../CommandPalette'

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  // Global Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="flex h-screen overflow-x-hidden">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <ConnectionBanner />
        <Header onToggleSidebar={toggleSidebar} onOpenSearch={openPalette} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-6">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  )
}
