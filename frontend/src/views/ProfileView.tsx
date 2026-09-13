// @ts-nocheck
import { ProfilePage, CreditsPanel, BillingSection } from '../components/ProfilePage'

interface ProfileViewProps {
  stats: any
  docs?: any[]
  onLogout: () => void
  onAuthRequired?: () => void
  highlightPalette: any
  setHighlightPalette: (v: any) => void
  monoHex: string
  setMonoHex: (v: string) => void
  contextMarkMode?: string
  setContextMarkMode?: (v: any) => void
  user: any
  initialSection?: string | null
}

/** Гостевой экран «Использование/Оплата»: баланс виден, пополнение требует входа — кнопка реально открывает регистрацию. */
function GuestCreditsView({ section, onAuthRequired }: { section: string; onAuthRequired?: () => void }) {
  return (
    <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-6 max-md:py-4">
      <div className="card p-6 max-md:p-4">
        {section === 'billing' ? (
          <>
            <h3 className="font-semibold text-slate-900 dark:text-white">Оплата</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Пакеты и подписки snippy.llm</p>
            <div className="mt-3 p-3 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 text-sm text-blue-800 dark:text-blue-300">
              Пополнение баланса доступно после регистрации — это бесплатно и занимает секунды. Зарегистрированные получают 300 кредитов каждый час по акции.
            </div>
            <button onClick={onAuthRequired} className="btn btn-md btn-primary mt-4 px-6 py-2.5 max-md:w-full">Создать аккаунт / Войти</button>
          </>
        ) : (
          <>
            <h3 className="font-semibold text-slate-900 dark:text-white">Использование</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Баланс кредитов гостя • 30 в день</p>
            <div className="mt-4">
              <CreditsPanel onTopUp={onAuthRequired} />
            </div>
            <div className="mt-4 p-3 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 text-xs text-blue-800 dark:text-blue-300">
              Регистрация бесплатная: 300 кредитов каждый час вместо 30 в день, накопительный баланс и история операций.
            </div>
            <button onClick={onAuthRequired} className="btn btn-md bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200 mt-3 px-6 py-2.5 max-md:w-full">Пополнить баланс</button>
          </>
        )}
      </div>
    </main>
  )
}

export function ProfileView({ stats, docs, onLogout, onAuthRequired, highlightPalette, setHighlightPalette, monoHex, setMonoHex, contextMarkMode, setContextMarkMode, user, initialSection }: ProfileViewProps) {
  if (!user) {
    if (initialSection === 'usage' || initialSection === 'billing') {
      return <GuestCreditsView section={initialSection} onAuthRequired={onAuthRequired} />
    }
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
        docs={docs}
        onLogout={onLogout}
        highlightPalette={highlightPalette}
        setHighlightPalette={setHighlightPalette}
        monoHex={monoHex}
        setMonoHex={setMonoHex}
        contextMarkMode={contextMarkMode}
        setContextMarkMode={setContextMarkMode}
        initialSection={initialSection}
      />
    </main>
  )
}
