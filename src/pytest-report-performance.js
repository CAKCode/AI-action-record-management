const { createResultTableRenderer } = require('./pytest-report-table');
const { showVideoCheckDetail } = require('./pytest-report-detail');

const LEGACY_RENDER_CONTENT = `const renderContent = (tests) => {
    const sortAttr = getSort(manager.initialSort)
    const sortAsc = JSON.parse(getSortDirection())
    const rows = tests.map(dom.getResultTBody)
    const table = document.getElementById('results-table')
    const tableHeader = document.getElementById('results-table-head')

    const newTable = document.createElement('table')
    newTable.id = 'results-table'

    // remove all sorting classes and set the relevant
    findAll('.sortable', tableHeader).forEach((elem) => elem.classList.remove('asc', 'desc'))
    tableHeader.querySelector(\`.sortable[data-column-type="\${sortAttr}"]\`)?.classList.add(sortAsc ? 'desc' : 'asc')
    newTable.appendChild(tableHeader)

    if (!rows.length) {
        const emptyTable = document.getElementById('template_results-table__body--empty').content.cloneNode(true)
        newTable.appendChild(emptyTable)
    } else {
        rows.forEach((row) => {
            if (!!row) {
                findAll('.collapsible td:not(.col-links):not(.col-video-check)', row).forEach(addItemToggleListener)
                find('.logexpander', row).addEventListener('click',
                    (evt) => evt.target.parentNode.classList.toggle('expanded'),
                )
                newTable.appendChild(row)
            }
        })
    }

    table.replaceWith(newTable)
}`;

// This adapter runs inside the historical bundle with its existing helpers.
function legacyResultRenderer() {
  const renderRows = createResultTableRenderer({
    createRow: dom.getResultTBody,
    onRowCreated: row => {
      findAll('.collapsible td:not(.col-links):not(.col-video-check)', row).forEach(addItemToggleListener);
      find('.logexpander', row)?.addEventListener('click', evt => evt.target.parentNode.classList.toggle('expanded'));
    },
    refreshRow: row => dom.refreshResult?.(row),
  });
  return tests => {
    const table = document.getElementById('results-table');
    const header = document.getElementById('results-table-head');
    const sortAttr = getSort(manager.initialSort);
    const sortAsc = JSON.parse(getSortDirection());
    findAll('.sortable', header).forEach(elem => elem.classList.remove('asc', 'desc'));
    header.querySelector(`.sortable[data-column-type="${sortAttr}"]`)?.classList.add(sortAsc ? 'desc' : 'asc');
    renderRows(table, header, tests);
  };
}

const PROGRESSIVE_RENDER_CONTENT = `const renderContent = (() => {
const createResultTableRenderer = ${createResultTableRenderer.toString()};
return (${legacyResultRenderer.toString()})();
})()`;

const LEGACY_ROW_CLONE = 'const resultBody = templateResult.content.cloneNode(true)';
const LIGHTWEIGHT_ROW_CLONE = `let rowTemplate = templateResult.content
        if (!extras?.some(({ format_type }) => ['image', 'video'].includes(format_type))) {
            if (!templateResult.__pytestHtmlTemplateWithoutMedia) {
                const lightweight = rowTemplate.cloneNode(true)
                lightweight.querySelector('.media')?.replaceChildren()
                templateResult.__pytestHtmlTemplateWithoutMedia = lightweight
            }
            rowTemplate = templateResult.__pytestHtmlTemplateWithoutMedia
        }
        const resultBody = rowTemplate.cloneNode(true)`;

const LEGACY_DETAIL_CACHE_WRITE = `            detailCache.set(cacheKey, envelope.detail)
            output.textContent = JSON.stringify(envelope.detail, null, 2)`;
const BOUNDED_DETAIL_CACHE_WRITE = `            const text = JSON.stringify(envelope.detail, null, 2)
            const bytes = text.length * 2
            if (bytes <= 8 * 1024 * 1024) {
                detailCacheBytes -= (detailCache.get(cacheKey)?.length || 0) * 2
                detailCache.delete(cacheKey)
                detailCache.set(cacheKey, text)
                detailCacheBytes += bytes
                while (detailCache.size > 32 || detailCacheBytes > 8 * 1024 * 1024) {
                    const oldest = detailCache.keys().next().value
                    detailCacheBytes -= detailCache.get(oldest).length * 2
                    detailCache.delete(oldest)
                }
            }
            if (window.__pytestVideoCheckDetails?.[caseId] === envelope) {
                delete window.__pytestVideoCheckDetails[caseId]
            }
            if (output.closest('details')?.open) showVideoCheckDetail(output, text)
            else output.textContent = '展开加载检查详情'`;

function progressivePytestReportHtml(html) {
  // Exact matching keeps unrelated bundles and versions on their own renderer.
  let output = html;
  for (const legacy of [LEGACY_RENDER_CONTENT,
    LEGACY_RENDER_CONTENT.replaceAll(':not(.col-links):not(.col-video-check)', ':not(.col-links)')]) {
    output = output.replace(legacy, () => PROGRESSIVE_RENDER_CONTENT);
  }
  if (output.includes(LEGACY_ROW_CLONE)) {
    output = output.replace(LEGACY_ROW_CLONE, () => LIGHTWEIGHT_ROW_CLONE);
    if (output.includes("const videoCheck = require('./videocheck.js')")) {
      output = output.replace('    getResultTBody: ({',
        '    refreshResult: root => videoCheck.renderCells(root),\n    getResultTBody: ({');
    }
  }
  if (output.includes(LEGACY_DETAIL_CACHE_WRITE)) {
    output = output.replace(LEGACY_DETAIL_CACHE_WRITE, () => BOUNDED_DETAIL_CACHE_WRITE)
      .replace('const detailCache = new Map()', 'const detailCache = new Map()\nlet detailCacheBytes = 0')
      .replace('        output.textContent = JSON.stringify(detailCache.get(cacheKey), null, 2)',
        `        const detail = detailCache.get(cacheKey)
        detailCache.delete(cacheKey)
        detailCache.set(cacheKey, detail)
        showVideoCheckDetail(output, detail)`)
      .replace('                if (details.open) loadDetails(cell.dataset.videoCheckCase, info, response)',
        `                const output = details.querySelector('pre')
                if (details.open) loadDetails(cell.dataset.videoCheckCase, info, output)
                else if (output.textContent !== '展开加载检查详情') {
                    const placeholder = document.createElement('pre')
                    placeholder.textContent = '展开加载检查详情'
                    output.replaceWith(placeholder)
                }`);
  }
  if (!output.includes("require('./detail-viewer.js')") && output.includes('const detailCache = new Map()')) {
    output = output.replace('const detailCache = new Map()',
      `${showVideoCheckDetail.toString()}\nconst detailCache = new Map()`)
      .replace("if (output.closest('details')?.open) output.textContent = text",
        "if (output.closest('details')?.open) showVideoCheckDetail(output, text)")
      .replace('        output.textContent = detail\n        return',
        '        showVideoCheckDetail(output, detail)\n        return');
  }
  return output;
}

module.exports = { progressivePytestReportHtml };
