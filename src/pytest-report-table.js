function createResultTableRenderer({ createRow, onRowCreated, refreshRow }) {
    const rows = new Map()
    const contentKeys = ['testId', 'result', 'log', 'extras', 'resultsTableRow', 'tableHtml']
    let pendingFrame = null
    let generation = 0

    const disposeRow = (row) => {
        row.querySelectorAll('video, audio').forEach((media) => {
            media.pause()
            media.removeAttribute('src')
            media.querySelectorAll('source').forEach((source) => source.removeAttribute('src'))
            media.load()
        })
        row.remove()
    }

    const prepareRow = (data) => {
        let entry = rows.get(data.id)
        if (entry && contentKeys.some((key) => entry.data[key] !== data[key])) {
            disposeRow(entry.row)
            rows.delete(data.id)
            entry = null
        }
        if (!entry) {
            const body = createRow(data)
            if (!body) return null
            const row = body.querySelector('tbody') || body
            onRowCreated?.(row)
            entry = { row, data }
            rows.set(data.id, entry)
        }
        const extras = entry.row.querySelector('.extras-row')
        if (data.collapsed && extras && !extras.classList.contains('hidden')) {
            entry.row.querySelectorAll('video, audio').forEach((media) => media.pause())
        }
        entry.row.querySelector('.collapsible > .col-result')?.classList.toggle('collapsed', !!data.collapsed)
        extras?.classList.toggle('hidden', !!data.collapsed)
        refreshRow?.(entry.row)
        entry.data = data
        return entry.row
    }

    return (table, header, tests) => {
        if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
        pendingFrame = null
        const currentGeneration = ++generation
        const visible = new Set(tests.map((data) => data.id))
        for (const [id, entry] of rows) {
            if (!visible.has(id)) {
                disposeRow(entry.row)
                rows.delete(id)
            }
        }
        const document = table.ownerDocument
        const fragment = document.createDocumentFragment()
        const caption = tests.length > 200 ? document.createElement('caption') : null
        table.replaceChildren(header)
        if (caption) {
            caption.setAttribute('role', 'status')
            table.prepend(caption)
        }
        if (!tests.length) {
            table.appendChild(document.getElementById('template_results-table__body--empty').content.cloneNode(true))
        }
        let position = 0
        let publishedPosition = 0
        const appendBatch = () => {
            if (generation !== currentGeneration || !table.isConnected) return
            pendingFrame = null
            const started = performance.now()
            const firstBatch = position === 0
            const budgetMs = firstBatch ? 12 : 50
            const end = caption ? Math.min(position + (firstBatch ? 50 : 250), tests.length) : tests.length
            do {
                if (position >= end) break
                const row = prepareRow(tests[position++])
                if (row) fragment.appendChild(row)
            } while (!caption || performance.now() - started < budgetMs)
            // Reuse row nodes; batching DOM writes avoids repeated layout while
            // preparing a large report. Hidden rows are evicted from the cache.
            if (firstBatch || position - publishedPosition >= 500 || position === tests.length) {
                table.appendChild(fragment)
                publishedPosition = position
                if (caption) caption.textContent = `Loading test cases (${position} / ${tests.length})`
            }
            if (position < tests.length) pendingFrame = requestAnimationFrame(appendBatch)
            else caption?.remove()
        }
        appendBatch()
    }
}

module.exports = { createResultTableRenderer }
