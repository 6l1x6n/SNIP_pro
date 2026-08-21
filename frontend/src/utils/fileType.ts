export const isPdf = (f: File | { name?: string; type?: string }): boolean => {
  const name = (f.name || '').trim().toLowerCase()
  const t = (f.type || '').toLowerCase()
  return name.endsWith('.pdf') || t === 'application/pdf' || t === 'application/x-pdf'
}

export const getFilesFromDataTransfer = (dt: DataTransfer): File[] => {
  if (dt.files && dt.files.length) return Array.from(dt.files)
  if (dt.items && dt.items.length) {
    const out: File[] = []
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f) out.push(f)
      }
    }
    if (out.length) return out
  }
  return []
}
