// @ts-nocheck
import { ProfilePage } from '../components/ProfilePage'

interface ProfileViewProps {
  stats: any
  onLogout: () => void
  highlightPalette: any
  setHighlightPalette: (v: any) => void
  monoHex: string
  setMonoHex: (v: string) => void
  user: any
  initialSection?: string | null
}

export function ProfileView({ stats, onLogout, highlightPalette, setHighlightPalette, monoHex, setMonoHex, user, initialSection }: ProfileViewProps) {
  if (!user) return null
  return (
    <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">
      <ProfilePage
        stats={stats}
        onLogout={onLogout}
        highlightPalette={highlightPalette}
        setHighlightPalette={setHighlightPalette}
        monoHex={monoHex}
        setMonoHex={setMonoHex}
        initialSection={initialSection}
      />
    </main>
  )
}
