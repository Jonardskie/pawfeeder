import LiveFeed from '../components/LiveFeed/LiveFeed'

export default function LiveFeedPage() {
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 20, color: 'var(--text-primary)' }}>
        Live Feed — Full View
      </h1>
      <LiveFeed />
    </div>
  )
}
