import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Video, HeartHandshake,
  ScrollText, Settings, Sun, Moon
} from 'lucide-react'
import Sidebar from './Sidebar'
import './DashboardLayout.css'

const MOBILE_NAV_ITEMS = [
  { to: '/',        icon: LayoutDashboard, label: 'Home' },
  { to: '/feed',    icon: Video,           label: 'Camera' },
  { to: '/donate',  icon: HeartHandshake,  label: 'Dispense' },
  { to: '/logs',    icon: ScrollText,      label: 'Logs' },
  { to: '/settings',icon: Settings,        label: 'Settings' },
]

export default function DashboardLayout({ children, deviceStatus, theme = 'dark', onToggleTheme }) {
  const isOnline = deviceStatus?.online ?? false

  return (
    <div className="layout">
      {/* Desktop Sidebar (hidden on mobile) */}
      <Sidebar
        online={isOnline}
        lastSeen={deviceStatus?.lastSeen ?? null}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />

      <div className="layout-content-wrapper">
        {/* Mobile Header (hidden on desktop) */}
        <header className="mobile-header">
          <div className="mobile-header-brand">
            <span className="mobile-logo-icon">🐾</span>
            <div className="mobile-brand-text">
              <span className="mobile-app-title">PawFeeder</span>
              <span className="mobile-app-sub">Community Feeder</span>
            </div>
          </div>
          <div className="mobile-header-right">
            <button
              type="button"
              className="theme-toggle-btn"
              onClick={onToggleTheme}
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              aria-label="Toggle Light/Dark Mode"
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <div className={`mobile-status-pill ${isOnline ? 'online' : 'offline'}`}>
              <span className="mobile-status-dot" />
              <span>{isOnline ? 'Online' : 'Offline'}</span>
            </div>
          </div>
        </header>

        {/* Main page content */}
        <main className="layout-main">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar (hidden on desktop) */}
      <nav className="mobile-bottom-nav">
        {MOBILE_NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `mobile-nav-link ${isActive ? 'mobile-nav-link--active' : ''}`
            }
          >
            <div className="mobile-nav-icon-wrap">
              <Icon size={20} strokeWidth={2} />
            </div>
            <span className="mobile-nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
