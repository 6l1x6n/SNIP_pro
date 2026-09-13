import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { Icon } from './Icon'

export function LoginForm({ onSwitch, onSuccess }: { onSwitch: () => void, onSuccess?: () => void }) {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setLoading(true)
    try { await login(email, password); onSuccess?.() } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }
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
  const [fullName, setFullName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setLoading(true)
    try { await register(email, password, fullName || undefined); onSuccess?.() } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="font-semibold text-slate-900 dark:text-white">Регистрация</h3>
      <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5"><Icon name="bolt" size={12} className="text-amber-500 shrink-0" /> Акция: 300 кредитов каждый час после регистрации. Бесплатно, без карты.</p>
      {err && <div className="text-xs bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded-xl p-2">{err}</div>}
      <input value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Имя (необязательно)" className="input" />
      <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" required className="input" />
      <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Пароль (мин 6)" type="password" required minLength={6} className="input" />
      <button disabled={loading} className="btn btn-md btn-primary w-full py-2.5">{loading ? 'Регистрация…' : 'Создать аккаунт'}</button>
      <button type="button" onClick={onSwitch} className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">Уже есть аккаунт? Войти</button>
    </form>
  )
}
