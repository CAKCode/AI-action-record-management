let descriptor = null
let payload = null
let timer = null
const detailCache = new Map()
const terminalWorkerStates = new Set(['finished', 'stopped', 'interrupted'])

const colors = {
    PASS: '#1b7b38', FAIL: '#ba2525', WARN: '#a05b00', ERROR: '#a05b00',
    RUNNING: '#3863b5', QUEUED: '#666', SKIPPED: '#666',
    INTERRUPTED: '#a05b00',
}

function renderCells(root = document) {
    if (!payload) return
    root.querySelectorAll('[data-video-check-case]').forEach((cell) => {
        const info = payload.cases?.[cell.dataset.videoCheckCase]
        if (!info) return
        const signature = JSON.stringify([
            info.status, info.counts, info.message, info.duration_ms,
            info.stage, info.validation_id, info.detail_updated_at,
        ])
        if (cell.dataset.checkSignature === signature) return
        const wasOpen = cell.querySelector('details')?.open || false
        cell.dataset.checkSignature = signature
        cell.replaceChildren()
        const details = document.createElement('details')
        details.open = wasOpen
        const summary = document.createElement('summary')
        summary.style.color = colors[info.status] || '#666'
        const counts = Object.entries(info.counts || {}).map(([key, value]) => `${key} ${value}`).join(' / ')
        summary.textContent = `${info.status}${counts ? ' · ' + counts : ''}`
        details.appendChild(summary)
        if (info.message) {
            const message = document.createElement('div')
            message.textContent = info.message
            details.appendChild(message)
        }
        const duration = document.createElement('div')
        duration.textContent = typeof info.duration_ms === 'number' ?
            `检查耗时 ${(info.duration_ms / 1000).toFixed(1)}s` : '检查结果异步更新'
        details.appendChild(duration)
        if (info.detail_source) {
            const response = document.createElement('pre')
            response.textContent = '展开加载检查详情'
            details.appendChild(response)
            const load = () => {
                if (details.open) loadDetails(cell.dataset.videoCheckCase, info, response)
            }
            details.addEventListener('toggle', load)
            load()
        }
        cell.appendChild(details)
    })
}

function detailUrl(summarySource, detailSource, updatedAt) {
    const slash = summarySource.lastIndexOf('/')
    const directory = slash < 0 ? '' : summarySource.slice(0, slash + 1)
    return `${directory}${detailSource}?t=${updatedAt || Date.now()}`
}

function loadDetails(caseId, info, output) {
    const cacheKey = `${caseId}:${info.detail_updated_at}`
    if (detailCache.has(cacheKey)) {
        output.textContent = JSON.stringify(detailCache.get(cacheKey), null, 2)
        return
    }
    if (output.dataset.loading === 'true') return
    output.dataset.loading = 'true'
    output.textContent = '检查详情加载中...'
    const script = document.createElement('script')
    script.src = detailUrl(descriptor.source, info.detail_source, info.detail_updated_at)
    script.onload = () => {
        const envelope = window.__pytestVideoCheckDetails?.[caseId]
        if (envelope?.run_id === descriptor.run_id && envelope.case_id === caseId) {
            detailCache.set(cacheKey, envelope.detail)
            output.textContent = JSON.stringify(envelope.detail, null, 2)
        } else {
            output.textContent = '检查详情与当前报告不匹配'
        }
        script.remove()
        delete output.dataset.loading
    }
    script.onerror = () => {
        output.textContent = '检查详情加载失败'
        script.remove()
        delete output.dataset.loading
    }
    document.body.appendChild(script)
}

function accept(update) {
    if (!descriptor || update?.run_id !== descriptor.run_id) return
    if (payload?.updated_at && update.updated_at < payload.updated_at) return
    payload = update
    renderCells()
    if (!isLive(payload) && timer !== null) {
        clearInterval(timer)
        timer = null
    }
}

function isLive(update) {
    return !update?.complete && !terminalWorkerStates.has(update?.worker_state)
}

function start(settings) {
    if (!settings) return
    descriptor = settings
    const snapshot = document.getElementById('video-check-snapshot')
    if (snapshot?.textContent) {
        try {
            accept(JSON.parse(snapshot.textContent))
        } catch (error) {
            // Poll the live file below.
        }
    }
    if (payload && !isLive(payload)) return
    let loading = false
    const poll = () => {
        if (loading) return
        loading = true
        const script = document.createElement('script')
        script.src = `${descriptor.source}?t=${Date.now()}`
        script.onload = () => {
            accept(window.__pytestVideoCheck)
            script.remove()
            loading = false
        }
        script.onerror = () => {
            script.remove()
            loading = false
        }
        document.body.appendChild(script)
    }
    timer = setInterval(poll, 3000)
    poll()
}

module.exports = { start, accept, renderCells, detailUrl, isLive }
