// @ts-nocheck
import { FavoritesSection } from '../components/FavoritesSection'

export function FavoritesView({ onOpenPdf, user }: {
  onOpenPdf: (docId: string, page?: number, quote?: string | null) => void
  user: any
}) {
  return (
    <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-6">
      <h1 className="text-xl font-bold text-slate-900 dark:text-white">Избранное</h1>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-5">Сохранённые ответы, фрагменты норм и страницы PDF • хранятся в этом браузере</p>
      <FavoritesSection onOpenPdf={onOpenPdf} user={user} />
    </main>
  )
}
