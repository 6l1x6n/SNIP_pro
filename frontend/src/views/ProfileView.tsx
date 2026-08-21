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
  if (!user) {
    return (
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
        <div className="max-w-md mx-auto bg-white rounded-2xl border border-slate-200 p-6 shadow-lg text-center">
          <img src="/logo-64.png" alt="snippy.llm" className="w-12 h-12 mx-auto rounded-xl object-cover border border-slate-200 bg-white" />
          <h3 className="font-semibold text-slate-900 mt-3">Профиль — войдите</h3>
          <p className="text-xs text-slate-500 mt-1">Документы и поиск работают без входа. Войдите чтобы видеть профиль, ключи и статистику.</p>
          <div className="mt-4 text-xs text-slate-400">Нажмите «Войти» в шапке</div>
        </div>
      </main>
    )
  }
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
