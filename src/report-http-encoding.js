const { gzip } = require('node:zlib');
const { promisify } = require('node:util');

const gzipAsync = promisify(gzip);

function acceptsGzip(header = '') {
  const encodings = new Map(String(header).toLowerCase().split(',').map(entry => {
    const [name, ...parameters] = entry.trim().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    return [name, quality == null ? 1 : Number(quality.trim().slice(2))];
  }));
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}

async function gzipHtmlArtifact(opened, acceptEncoding) {
  if (opened.mediaType !== 'text/html; charset=utf-8' || !Buffer.isBuffer(opened.content)
    || opened.bytes < 1024 || !acceptsGzip(acceptEncoding)) return opened;
  const content = await gzipAsync(opened.content, { level: 1 });
  return { ...opened, content, bytes: content.length, contentEncoding: 'gzip' };
}

module.exports = { acceptsGzip, gzipHtmlArtifact };
