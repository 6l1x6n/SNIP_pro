import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

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
      <h3 className="font-semibold text-slate-900">Вход</h3>
      {err && <div className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-xl p-2">{err}</div>}
      <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" required className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Пароль" type="password" required className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <button disabled={loading} className="w-full py-2.5 bg-slate-900 text-white rounded-xl text-sm font-medium hover:bg-black disabled:opacity-50">{loading?'Вход...':'Войти'}</button>
      <button type="button" onClick={onSwitch} className="w-full text-xs text-slate-500 hover:text-slate-700">Нет аккаунта? Зарегистрироваться</button>
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
      <h3 className="font-semibold text-slate-900">Регистрация</h3>
      <p className="text-xs text-slate-500">Первый пользователь станет админом. Бесплатно для 10+ пользователей, данные на snippy.llm.</p>
      {err && <div className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-xl p-2">{err}</div>}
      <input value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Имя (необязательно)" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" required className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Пароль (мин 6)" type="password" required minLength={6} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <button disabled={loading} className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50">{loading?'Регистрация...':'Создать аккаунт'}</button>
      <button type="button" onClick={onSwitch} className="w-full text-xs text-slate-500 hover:text-slate-700">Уже есть аккаунт? Войти</button>
    </form>
  )
}
