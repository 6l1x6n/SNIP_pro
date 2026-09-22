import { describe, expect, it } from 'vitest'
import { canAccessTab, resolveActiveTab, type Tab } from './tabs'

const admin = { email: 'postalarchive@gmail.com' }
const user = { email: 'someone@example.com' }
const publicTabs: Tab[] = ['search', 'docs', 'favorites', 'profile']

describe('canAccessTab', () => {
  it.each(publicTabs)('гость имеет доступ к «%s»', (tab) => {
    expect(canAccessTab(tab, null)).toBe(true)
  })

  it.each(publicTabs)('залогиненный имеет доступ к «%s»', (tab) => {
    expect(canAccessTab(tab, user)).toBe(true)
    expect(canAccessTab(tab, admin)).toBe(true)
  })

  it('админка недоступна гостю', () => {
    expect(canAccessTab('admin', null)).toBe(false)
    expect(canAccessTab('admin', undefined)).toBe(false)
  })

  it('админка недоступна обычному пользователю', () => {
    expect(canAccessTab('admin', user)).toBe(false)
  })

  it('админка доступна админу (регистр/пробелы не важны)', () => {
    expect(canAccessTab('admin', admin)).toBe(true)
    expect(canAccessTab('admin', { email: ' PostalArchive@GMail.com ' })).toBe(true)
  })
})

describe('resolveActiveTab', () => {
  it('при потере доступа уводит в профиль', () => {
    expect(resolveActiveTab('admin', null)).toBe('profile')
    expect(resolveActiveTab('admin', user)).toBe('profile')
  })

  it('админ остаётся на админке', () => {
    expect(resolveActiveTab('admin', admin)).toBe('admin')
  })

  it('доступные табы не трогает', () => {
    expect(resolveActiveTab('search', null)).toBe('search')
    expect(resolveActiveTab('docs', user)).toBe('docs')
    expect(resolveActiveTab('favorites', user)).toBe('favorites')
    expect(resolveActiveTab('profile', null)).toBe('profile')
  })
})
