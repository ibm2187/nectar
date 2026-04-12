import { useState, useCallback } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { ConnectionBanner } from './ConnectionBanner'

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

  return (
    <div className="flex h-screen overflow-x-hidden">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <ConnectionBanner />
        <Header onToggleSidebar={toggleSidebar} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
