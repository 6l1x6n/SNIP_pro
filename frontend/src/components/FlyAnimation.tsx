import { useEffect } from 'react'
import { usePinned } from '../context/PinnedContext'

export function FlyAnimation() {
  const { flyTrigger, lastFlyFrom, docsTabRef, pinnedButtonRef, lastFlyTarget } = usePinned()

  useEffect(() => {
    const targetRef = lastFlyTarget === 'pins' ? pinnedButtonRef : docsTabRef
    if (!flyTrigger || !lastFlyFrom || !targetRef?.current) return
    const from = lastFlyFrom
    const toEl = targetRef.current as HTMLElement
    const to = toEl.getBoundingClientRect()

    // respect reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      toEl.classList.add('pin-pulse')
      setTimeout(() => toEl.classList.remove('pin-pulse'), 600)
      return
    }

    const clone = document.createElement('div')
    clone.className = 'fly-clone'
    clone.style.left = `${from.left + from.width / 2}px`
    clone.style.top = `${from.top + from.height / 2}px`
    clone.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#f59e0b" stroke="#fff" stroke-width="1.2"><path d="M12 2l2.2 6.5H21l-5.5 4 2.1 6.5L12 15l-5.6 4 2.1-6.5L3 8.5h6.8z"/></svg>`
    document.body.appendChild(clone)

    // force reflow
    void clone.offsetWidth
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2)
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2)

    clone.style.transform = `translate(${dx}px, ${dy}px) scale(0.35) rotate(12deg)`
    clone.style.opacity = '0.9'

    const onEnd = () => {
      clone.remove()
      // pulse docs tab + badge
      toEl.classList.remove('pin-pulse')
      void toEl.offsetWidth
      toEl.classList.add('pin-pulse')
      setTimeout(() => toEl.classList.remove('pin-pulse'), 700)
      // small confetti via badge
      const badge = toEl.querySelector('.docs-badge') || document.querySelector('.pin-badge')
      if (badge) {
        badge.classList.remove('pin-bounce')
        void (badge as HTMLElement).offsetWidth
        badge.classList.add('pin-bounce')
        setTimeout(() => badge.classList.remove('pin-bounce'), 700)
      }
    }
    clone.addEventListener('transitionend', onEnd, { once: true })
    setTimeout(() => { if (clone.parentElement) { clone.remove(); onEnd() } }, 900)
  }, [flyTrigger, lastFlyFrom, docsTabRef, pinnedButtonRef, lastFlyTarget])

  return null
}
