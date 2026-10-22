import Sidebar from './Sidebar'
import './DashboardLayout.css'

export default function DashboardLayout({ children, deviceStatus }) {
  return (
    <div className="layout">
      <Sidebar
        online={deviceStatus?.online ?? false}
        lastSeen={deviceStatus?.lastSeen ?? null}
      />
      <main className="layout-main">
        {children}
      </main>
    </div>
  )
}
