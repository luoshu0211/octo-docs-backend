type EditContext = { readOnly: boolean; doc: unknown; slide: { id: string } }

let dismiss: (() => void) | undefined
export function closeHostedDialog() { dismiss?.() }

/** Text-only, keyboard accessible replacement for native browser dialogs. */
export function openHostedDialog(message: string, options: { value?: string; danger?: boolean; notice?: boolean } = {}): Promise<string | null> {
  document.querySelector<HTMLButtonElement>('.octo-ppt-help-close')?.click()
  closeHostedDialog()
  const zh = document.documentElement.lang.startsWith('zh')
  const previous = document.activeElement as HTMLElement | null
  const overlay = document.createElement('div'); overlay.className = 'ed-about-overlay octo-ppt-dialog-overlay'
  const box = document.createElement('div'); box.className = 'ed-about octo-ppt-dialog'
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true')
  const title = document.createElement('h2'); title.id = 'octo-ppt-dialog-title'
  title.textContent = options.value !== undefined ? (zh ? '保存版式' : 'Save layout') : options.danger ? (zh ? '确认删除' : 'Confirm deletion') : (zh ? '提示' : 'Notice')
  box.setAttribute('aria-labelledby', title.id)
  const description = document.createElement('p'); description.id = 'octo-ppt-dialog-description'; description.textContent = message
  box.setAttribute('aria-describedby', description.id); box.append(title, description)
  const input = options.value === undefined ? undefined : document.createElement('input')
  if (input) { input.value = options.value!; input.setAttribute('aria-label', message); box.append(input) }
  const footer = document.createElement('div'); footer.className = 'octo-ppt-dialog-footer'
  const cancel = document.createElement('button'); cancel.className = 'ed-btn'; cancel.textContent = zh ? '取消' : 'Cancel'
  const ok = document.createElement('button'); ok.className = options.danger ? 'ed-btn octo-ppt-danger' : 'ed-btn ed-btn-primary'
  ok.textContent = options.notice ? (zh ? '知道了' : 'Got it') : options.value !== undefined ? (zh ? '保存' : 'Save') : options.danger ? (zh ? '删除' : 'Delete') : (zh ? '继续' : 'Continue')
  if (!options.notice) footer.append(cancel)
  footer.append(ok); box.append(footer); overlay.append(box)
  return new Promise(resolve => {
    const close = (value: string | null) => {
      document.removeEventListener('keydown', onKey, true); overlay.remove(); dismiss = undefined
      if (previous?.isConnected) previous.focus()
      resolve(value)
    }
    const onKey = (event: KeyboardEvent) => {
      event.stopImmediatePropagation()
      if (event.key === 'Escape') { event.preventDefault(); close(null) }
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && document.activeElement === input) { event.preventDefault(); ok.click() }
      if (event.key === 'Tab') {
        event.preventDefault()
        const targets = [input, options.notice ? undefined : cancel, ok].filter((node): node is HTMLInputElement | HTMLButtonElement => !!node && !node.disabled)
        const index = targets.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement)
        targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length].focus()
      }
    }
    const valid = () => { ok.disabled = !!input && !input.value.trim() }
    input?.addEventListener('input', valid); valid()
    cancel.onclick = () => close(null); ok.onclick = () => close(input?.value.trim() ?? 'confirmed')
    overlay.onclick = event => { if (event.target === overlay) close(null) }
    dismiss = () => close(null)
    document.addEventListener('keydown', onKey, true); (document.fullscreenElement ?? document.body).append(overlay)
    ;(input ?? (options.notice ? ok : cancel)).focus(); input?.select()
  })
}

/** A dialog must never apply a decision to content changed while it was open. */
export async function requestHostedEdit(store: EditContext, message: string, options: { value?: string; danger?: boolean } = {}) {
  if (store.readOnly) return null
  const before = JSON.stringify(store.doc), slideId = store.slide.id
  const result = await openHostedDialog(message, options)
  if (store.readOnly || store.slide.id !== slideId || JSON.stringify(store.doc) !== before) return null
  return result
}

export function showHostedNotice(message: string) { void openHostedDialog(message, { notice: true }) }
