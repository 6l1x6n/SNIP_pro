import { useState } from 'react'
import { useAuth, AuthError } from '../context/AuthContext'
import { Icon } from './Icon'
import { DeletedAccountLetter, type DeletedNotice } from './DeletedAccountLetter'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function LoginForm({ onSwitch, onSuccess }: { onSwitch: () => void, onSuccess?: () => void }) {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [deleted, setDeleted] = useState<DeletedNotice | null>(null)
  const [loading, setLoading] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setLoading(true)
    try { await login(email, password); onSuccess?.() } catch (e: any) {
      if (e instanceof AuthError && e.code === 'account_deleted' && e.notice) setDeleted(e.notice as unknown as DeletedNotice)
      else setErr(e.message)
    } finally { setLoading(false) }
  }
  if (deleted) return <DeletedAccountLetter notice={deleted} onClose={() => { setDeleted(null); setErr(null) }} />
  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="font-semibold text-slate-900 dark:text-white">Вход</h3>
      {err && <div className="text-xs bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded-xl p-2">{err}</div>}
      <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" required className="input" />
      <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Пароль" type="password" required className="input" />
      <button disabled={loading} className="btn btn-md w-full py-2.5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200">{loading ? 'Вход…' : 'Войти'}</button>
      <button type="button" onClick={onSwitch} className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">Нет аккаунта? Зарегистрироваться</button>
    </form>
  )
}

export function RegisterForm({ onSwitch, onSuccess }: { onSwitch: () => void, onSuccess?: () => void }) {
  const { register } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [fullName, setFullName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    // мейлера нет: формат почты и совпадение паролей проверяем здесь и на сервере
    if (!EMAIL_RE.test(email.trim())) { setErr('Проверьте email — выглядит опечаткой (пример: name@mail.kz)'); return }
    if (password !== password2) { setErr('Пароли не совпадают'); return }
    setLoading(true)
    try { await register(email.trim(), password, fullName || undefined); onSuccess?.() } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="font-semibold text-slate-900 dark:text-white">Регистрация</h3>
      <p className="text-xs text-slate-600 dark:text-slate-300 flex items-start gap-1.5 leading-relaxed">
        <Icon name="bolt" size={12} className="text-amber-500 shrink-0 mt-0.5" />
        <span>300 токенов каждый час вместо 30 у гостей<br /><span className="text-slate-400 dark:text-slate-500">бесплатно, без карты</span></span>
      </p>
      {err && <div className="text-xs bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded-xl p-2">{err}</div>}
      <input value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Имя (необязательно)" className="input" />
      <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" required className="input" />
      <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Пароль (мин 6)" type="password" required minLength={6} className="input" />
      <input value={password2} onChange={e=>setPassword2(e.target.value)} placeholder="Повторите пароль" type="password" required minLength={6} className={`input ${password2 && password2 !== password ? 'border-red-400 dark:border-red-700' : ''}`} />
      {password2 && password2 !== password && <p className="text-xs text-red-600 dark:text-red-400 -mt-2">Пароли не совпадают</p>}
      <button disabled={loading || !password || password !== password2} className="btn btn-md btn-primary w-full py-2.5">{loading ? 'Регистрация…' : 'Создать аккаунт'}</button>
      <button type="button" onClick={onSwitch} className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">Уже есть аккаунт? Войти</button>
    </form>
  )
}
