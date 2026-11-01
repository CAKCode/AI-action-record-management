const test = require('node:test')
const assert = require('node:assert/strict')
const { showVideoCheckDetail } = require('../src/pytest-report-detail')

function fixture() {
    let copied = ''
    class Element {
        constructor(tag) {
            this.tag = tag
            this.children = []
            this.style = {}
            this.dataset = {}
            this.events = new Map()
            this.ownerDocument = document
            this.scrollTop = 0
            this.offsetHeight = tag === 'span' ? 28 : 350
        }
        set textContent(value) {
            this.text = value
            this.children = []
        }
        get textContent() {
            return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text || ''
        }
        append(...children) {
            this.children.push(...children)
        }
        replaceChildren(...children) {
            this.text = ''
            this.children = children
        }
        addEventListener(name, callback) {
            this.events.set(name, callback)
        }
        removeEventListener(name) {
            this.events.delete(name)
        }
        getAttribute(name) {
            if (name === 'style') return null
            return this[name] || null
        }
        setAttribute(name, value) {
            this[name] = value
        }
        removeAttribute(name) {
            if (name === 'style') this.style = {}
            else delete this[name]
        }
        querySelector(tag) {
            return this.children.find((child) => child.tag === tag) || null
        }
        scrollIntoView() {
            this.scrolled = true
        }
        focus() {
            this.focused = true
        }
    }
    const document = {
        createElement: (tag) => new Element(tag),
        createTextNode: (text) => Object.assign(new Element('#text'), { textContent: text }),
        defaultView: { navigator: { clipboard: { writeText: (text) => {
            copied = text
            return Promise.resolve()
        } } } },
    }
    return { output: new Element('pre'), copied: () => copied }
}

test('large JSON scrolls and searches all lines while rendering only a small window', async () => {
    const test = fixture()
    const text = Array.from({ length: 30000 }, (_, index) => `LINE-${index}: original content`).join('\n')
    showVideoCheckDetail(test.output, text)
    assert.equal(test.output.dataset.virtualJson, 'true')
    const [toolbar, , lines] = test.output.children
    assert.ok(lines.textContent.includes('LINE-0:'))
    assert.equal(lines.textContent.includes('LINE-29999:'), false)
    assert.ok(lines.textContent.split('\n').length <= 80)
    test.output.scrollTop = 29980 * 18 + toolbar.offsetHeight
    test.output.events.get('scroll')()
    assert.ok(lines.textContent.includes('LINE-29999:'))
    assert.ok(lines.textContent.split('\n').length <= 80)
    const [copy, search, next, status] = toolbar.children
    search.value = 'LINE-25000:'
    next.events.get('click')()
    assert.ok(lines.textContent.includes('LINE-25000:'))
    assert.ok(status.textContent.includes('25001'))
    await copy.events.get('click')()
    assert.equal(test.copied(), text)
    showVideoCheckDetail(test.output, '{"small": true}')
    assert.equal('virtualJson' in test.output.dataset, false)
    assert.equal(test.output.events.has('scroll'), false)
    assert.equal(test.output.textContent, '{"small": true}')
})

test('a floating result closes its owning disclosure and releases its viewer state', () => {
    const test = fixture()
    const details = { open: true }
    let shown = false
    test.output.isConnected = true
    test.output.closest = () => details
    test.output.matches = () => shown
    test.output.showPopover = () => {
        shown = true
    }
    test.output.hidePopover = () => {
        shown = false
        test.output.events.get('toggle')?.({ newState: 'closed' })
    }
    showVideoCheckDetail(test.output, 'complete data\n'.repeat(20000))
    assert.equal(shown, false)
    const enlarge = test.output.children[0].children[5]
    enlarge.events.get('click')()
    assert.equal(test.output.dataset.detailPopup, 'true')
    assert.equal(shown, true)
    assert.equal(test.output.focused, true)
    const close = test.output.children[0].children[4]
    close.events.get('click')()
    assert.equal(details.open, false)
    showVideoCheckDetail(test.output, 'small')
    assert.equal('detailPopup' in test.output.dataset, false)
    assert.equal(test.output.events.has('toggle'), false)
})
