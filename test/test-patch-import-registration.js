import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { patchAndImportTools, ApplyPatchArgsSchema, ImportFileArgsSchema } from '../dist/tools/patch-and-import-schemas.js';
import { toolArgSchemas } from '../dist/tools/schemas.js';

test('both new tools are included in the central schema map', () => {
    assert.equal(toolArgSchemas.apply_patch, ApplyPatchArgsSchema);
    assert.equal(toolArgSchemas.import_file, ImportFileArgsSchema);
});
test('ChatGPT file metadata and schema declare all four supported properties', () => {
    const tool = patchAndImportTools.find(tool => tool.name === 'import_file');
    assert.deepEqual(tool._meta['openai/fileParams'], ['file']);
    const file = tool.inputSchema.properties.file;
    assert.equal(file.type, 'object');
    assert.deepEqual(Object.keys(file.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
    assert.deepEqual([...file.required].sort(), ['download_url', 'file_id']);
    assert.equal(file.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, false);
});
test('file import defaults to no overwrite and accepts omitted optional file metadata', () => {
    const parsed = ImportFileArgsSchema.parse({ file: { file_id: 'f', download_url: 'https://example.com/f' }, destination: '/tmp/f' });
    assert.equal(parsed.overwrite, false);
    assert.equal(parsed.file.mime_type, undefined);
    assert.equal(ImportFileArgsSchema.safeParse({ file: '/mnt/data/f.png', destination: '/tmp/f' }).success, false);
});
test('patch requires an explicit working directory', () => {
    assert.equal(ApplyPatchArgsSchema.safeParse({ patch: 'patch' }).success, false);
});
test('server dispatch and tool-list integration are present', async () => {
    const source = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    assert.ok(source.includes('...patchAndImportTools,'));
    assert.ok(source.includes('result = await handleApplyPatch(args);'));
    assert.ok(source.includes('result = await handleImportFile(args);'));
    assert.ok(source.includes('trackToolCall(name, redactFileInput(name, args));'));
    assert.ok(source.includes('toolHistory.addCall(name, redactFileInput(name, args), result, duration);'));
});
