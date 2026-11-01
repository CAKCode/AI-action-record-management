function showVideoCheckDetail(output, text) {
    output.__pytestDetailCleanup?.()
    output.replaceChildren()
    output.dataset.detailReady = 'true'
    if (text.length <= 64 * 1024) {
        output.textContent = text
        return
    }

    const document = output.ownerDocument
    const originalStyle = output.getAttribute('style')
    const originalPopover = output.getAttribute('popover')
    const originalTabIndex = output.getAttribute('tabindex')
    const floating = typeof output.showPopover === 'function'
    const lineHeight = 18
    const starts = [0]
    let position = text.indexOf('\n')
    while (position !== -1) {
        starts.push(position + 1)
        position = text.indexOf('\n', position + 1)
    }
    const offsets = Uint32Array.from(starts)
    output.dataset.virtualJson = 'true'
    Object.assign(output.style, {
        height: '350px', boxSizing: 'border-box', overflow: 'auto', contain: 'strict',
        whiteSpace: 'normal', overflowWrap: 'normal', font: '12px/18px monospace', padding: '8px',
    })
    output.setAttribute('tabindex', '0')
    const toolbar = document.createElement('span')
    Object.assign(toolbar.style, {
        display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center',
        position: 'sticky', top: '0', zIndex: '1', background: '#f8fafc', color: '#1f2937',
        padding: '4px 0', whiteSpace: 'normal',
    })
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '复制完整 JSON'
    const search = document.createElement('input')
    search.type = 'search'
    search.placeholder = '全文查找'
    search.setAttribute('aria-label', '在完整 JSON 中查找')
    Object.assign(search.style, { flex: '1', minWidth: '60px', width: '100px' })
    const next = document.createElement('button')
    next.type = 'button'
    next.textContent = '查找下一个'
    const status = document.createElement('span')
    status.setAttribute('role', 'status')
    status.textContent = `${offsets.length.toLocaleString()} 行`
    toolbar.append(copy, search, next, status)
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '关闭结果'
    close.addEventListener('click', () => {
        if (floating && output.matches(':popover-open')) output.hidePopover()
        else {
            const details = output.closest('details')
            if (details) details.open = false
        }
    })
    toolbar.append(close)
    if (floating) {
        const enlarge = document.createElement('button')
        enlarge.type = 'button'
        enlarge.textContent = '放大结果'
        enlarge.addEventListener('click', () => {
            if (!output.isConnected) return
            output.popover = 'auto'
            output.dataset.detailPopup = 'true'
            Object.assign(output.style, {
                position: 'fixed', inset: '0', margin: 'auto', width: 'min(900px, calc(100vw - 32px))',
                maxWidth: 'calc(100vw - 32px)', height: 'min(70vh, 500px)', maxHeight: '70vh',
                background: '#fff', color: '#111827', border: '1px solid #cbd5e1', borderRadius: '8px',
                boxShadow: '0 18px 70px rgba(0,0,0,.35)',
            })
            output.showPopover()
            output.focus({ preventScroll: true })
        })
        toolbar.append(enlarge)
    }
    const top = document.createElement('span')
    const lines = document.createElement('span')
    const bottom = document.createElement('span')
    for (const element of [top, lines, bottom]) {
        Object.assign(element.style, { display: 'block', whiteSpace: 'pre', overflowWrap: 'normal' })
    }
    lines.dataset.jsonLines = 'true'
    output.append(toolbar, top, lines, bottom)
    output.scrollTop = 0
    let firstVisible = -1
    let match = -1
    let query = ''
    let nextMatch = 0

    const render = () => {
        const scroll = Math.max(0, output.scrollTop)
        const first = Math.max(0, Math.floor(scroll / lineHeight) - 12)
        if (firstVisible === first) return
        firstVisible = first
        const end = Math.min(offsets.length, first + 80)
        const startOffset = offsets[first]
        const endOffset = end < offsets.length ? offsets[end] - 1 : text.length
        const content = text.slice(startOffset, endOffset)
        top.style.height = `${first * lineHeight}px`
        bottom.style.height = `${(offsets.length - end) * lineHeight}px`
        lines.style.height = `${(end - first) * lineHeight}px`
        lines.replaceChildren()
        if (match >= startOffset && match < endOffset) {
            const mark = document.createElement('mark')
            mark.textContent = text.slice(match, Math.min(match + query.length, endOffset))
            lines.append(document.createTextNode(text.slice(startOffset, match)), mark,
                document.createTextNode(text.slice(Math.min(match + query.length, endOffset), endOffset)))
        } else lines.textContent = content
    }

    const findNext = () => {
        if (search.value !== query) nextMatch = 0
        query = search.value
        if (!query) return
        match = text.indexOf(query, nextMatch)
        if (match === -1 && nextMatch) match = text.indexOf(query)
        if (match === -1) {
            status.textContent = '未找到'
            return
        }
        nextMatch = match + Math.max(1, query.length)
        let low = 0
        let high = offsets.length - 1
        while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            if (offsets[middle] <= match) low = middle
            else high = middle - 1
        }
        output.scrollTop = low * lineHeight
        status.textContent = `第 ${low + 1} / ${offsets.length} 行`
        firstVisible = -1
        render()
        lines.querySelector('mark')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    next.addEventListener('click', findNext)
    search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault()
            findNext()
        }
    })
    copy.addEventListener('click', async () => {
        let copied = false
        try {
            const clipboard = document.defaultView?.navigator?.clipboard
            if (clipboard) {
                await clipboard.writeText(text)
                copied = true
            }
        } catch {
            // Opaque and file origins may need the user-gesture copy fallback.
        }
        if (!copied) {
            const selection = document.createElement('textarea')
            selection.value = text
            selection.wrap = 'off'
            Object.assign(selection.style, { position: 'fixed', left: '-9999px', width: '1px', height: '1px' })
            document.body.appendChild(selection)
            selection.select()
            try {
                copied = typeof document.execCommand === 'function' && document.execCommand('copy')
            } catch {
                copied = false
            } finally {
                selection.remove()
            }
            copy.focus({ preventScroll: true })
        }
        status.textContent = copied ? '已复制完整 JSON' : '浏览器未完成复制'
    })
    output.addEventListener('scroll', render, { passive: true })
    const onToggle = (event) => {
        if (event.newState !== 'closed') return
        const details = output.closest('details')
        if (details) details.open = false
    }
    if (floating) output.addEventListener('toggle', onToggle)
    output.__pytestDetailCleanup = () => {
        output.removeEventListener('scroll', render)
        output.removeEventListener('toggle', onToggle)
        if (floating && output.matches(':popover-open')) output.hidePopover()
        if (originalStyle === null) output.removeAttribute('style')
        else output.setAttribute('style', originalStyle)
        if (originalPopover === null) output.removeAttribute('popover')
        else output.setAttribute('popover', originalPopover)
        if (originalTabIndex === null) output.removeAttribute('tabindex')
        else output.setAttribute('tabindex', originalTabIndex)
        delete output.dataset.virtualJson
        delete output.dataset.detailPopup
        output.__pytestDetailCleanup = null
    }
    render()
}

module.exports = { showVideoCheckDetail }
