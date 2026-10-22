import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Video, HeartHandshake,
  ScrollText, Settings
} from 'lucide-react'
import './Sidebar.css'

const NAV_ITEMS = [
  { to: '/',        icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/feed',    icon: Video,           label: 'Live Feed'  },
  { to: '/donate',  icon: HeartHandshake,  label: 'Donate'     },
  { to: '/logs',    icon: ScrollText,      label: 'Logs'       },
  { to: '/settings',icon: Settings,        label: 'Settings'   },
]

export default function Sidebar({ online, lastSeen }) {
  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <span className="sidebar-logo-icon">🐾</span>
        <div>
          <div className="sidebar-logo-name">PawFeeder</div>
          <div className="sidebar-logo-sub">Community Feeder • Unit 001</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `sidebar-link${isActive ? ' sidebar-link--active' : ''}`
            }
          >
            <Icon size={18} strokeWidth={1.8} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Status */}
      <div className="sidebar-status">
        <span className={`dot ${online ? 'dot-green' : 'dot-red'}`} />
        <div>
          <div className="sidebar-status-label">{online ? 'Online' : 'Offline'}</div>
          <div className="sidebar-status-time">
            {lastSeen ? `Last seen ${lastSeen}` : 'Connecting...'}
          </div>
        </div>
      </div>
    </aside>
  )
}
