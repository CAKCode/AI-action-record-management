const test = require('node:test');
const assert = require('node:assert/strict');
const yazl = require('yazl');
const { parseSkillArchive } = require('../src/skill-archive');

function skillMarkdown(name, description = 'Imported test Skill.') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFollow the test workflow.\n`;
}

function createZip(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.content), entry.path, {
        mode: entry.mode ?? 0o100644,
        compress: entry.compress !== false,
      });
    }
    zip.end();
  });
}

function replaceAll(buffer, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const result = Buffer.from(buffer);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(from, offset)) !== -1) {
    result.write(to, offset, 'utf8');
    offset += Buffer.byteLength(to);
    replacements += 1;
  }
  assert.ok(replacements >= 2);
  return result;
}

test('a Codex Skill ZIP preserves multiple files, binary content, and executable mode', async () => {
  const binary = Buffer.from([0, 1, 2, 255]);
  const archive = await createZip([
    { path: 'zip-test/SKILL.md', content: skillMarkdown('zip-test') },
    { path: 'zip-test/scripts/run.sh', content: '#!/bin/sh\nprintf ok\n', mode: 0o100755 },
    { path: 'zip-test/assets/data.bin', content: binary },
  ]);
  const [skill] = await parseSkillArchive(archive);
  assert.equal(skill.id, 'zip-test');
  assert.equal(skill.description, 'Imported test Skill.');
  assert.deepEqual(skill.files.map((file) => file.path), [
    'SKILL.md', 'scripts/run.sh', 'assets/data.bin',
  ]);
  assert.deepEqual(skill.files.find((file) => file.path === 'assets/data.bin').content, binary);
  assert.equal(skill.files.find((file) => file.path === 'scripts/run.sh').mode, 0o755);
});
test('a Skill ZIP may contain multiple official Skill folders', async () => {
  const archive = await createZip([
    { path: 'bundle/first-skill/SKILL.md', content: skillMarkdown('first-skill') },
    { path: 'bundle/second-skill/SKILL.md', content: skillMarkdown('second-skill') },
  ]);
  assert.deepEqual((await parseSkillArchive(archive)).map((skill) => skill.id), ['first-skill', 'second-skill']);
});

test('Skill ZIP validation rejects unsafe and ambiguous layouts', async () => {
  const nested = await createZip([
    { path: 'parent-skill/SKILL.md', content: skillMarkdown('parent-skill') },
    { path: 'parent-skill/child-skill/SKILL.md', content: skillMarkdown('child-skill') },
  ]);
  await assert.rejects(parseSkillArchive(nested), /Nested Skill roots/);

  const mismatched = await createZip([
    { path: 'wrong-folder/SKILL.md', content: skillMarkdown('right-name') },
  ]);
  await assert.rejects(parseSkillArchive(mismatched), /must match frontmatter name/);

  const outside = await createZip([
    { path: 'safe-skill/SKILL.md', content: skillMarkdown('safe-skill') },
    { path: 'README.md', content: 'outside' },
  ]);
  await assert.rejects(parseSkillArchive(outside), /outside a Skill folder/);

  const duplicate = await createZip([
    { path: 'duplicate-skill/SKILL.md', content: skillMarkdown('duplicate-skill') },
    { path: 'duplicate-skill/SKILL.md', content: skillMarkdown('duplicate-skill') },
  ]);
  await assert.rejects(parseSkillArchive(duplicate), /Duplicate ZIP path/);
});

test('Skill ZIP validation rejects path traversal, links, encryption, and oversized files', async () => {
  const traversalBase = await createZip([
    { path: 'aa/evil.md', content: 'unsafe' },
    { path: 'safe-skill/SKILL.md', content: skillMarkdown('safe-skill') },
  ]);
  await assert.rejects(parseSkillArchive(replaceAll(traversalBase, 'aa/evil.md', '../evil.md')), /ZIP|path|relative/i);

  const linked = await createZip([
    { path: 'linked-skill/SKILL.md', content: skillMarkdown('linked-skill') },
    { path: 'linked-skill/scripts/link', content: '../target', mode: 0o120777 },
  ]);
  await assert.rejects(parseSkillArchive(linked), /Symbolic links/);

  const encrypted = await createZip([
    { path: 'encrypted-skill/SKILL.md', content: skillMarkdown('encrypted-skill') },
  ]);
  for (let offset = 0; offset < encrypted.length - 10; offset += 1) {
    const signature = encrypted.readUInt32LE(offset);
    if (signature === 0x04034b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(offset + 6) | 1, offset + 6);
    if (signature === 0x02014b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(offset + 8) | 1, offset + 8);
  }
  await assert.rejects(parseSkillArchive(encrypted), /Encrypted ZIP entries/);

  const oversized = await createZip([
    { path: 'large-skill/SKILL.md', content: skillMarkdown('large-skill') },
    { path: 'large-skill/assets/large.bin', content: Buffer.alloc((4 * 1024 * 1024) + 1) },
  ]);
  await assert.rejects(parseSkillArchive(oversized), /too large/);
});
