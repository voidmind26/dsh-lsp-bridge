import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../src/catalog.js';
import { discoverWorkspace } from '../src/discovery.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

async function executable(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return realpath(file);
}

async function marker(root, relative, name, content = '') {
  const directory = path.join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), content);
  return directory;
}

test('固定目录包含五类语言、正确 languageId 和纯文本安装建议', () => {
  assert.deepEqual(CATALOG.map(item => item.id), ['go', 'rust', 'tsjs', 'python', 'cpp']);
  const tsjs = CATALOG.find(item => item.id === 'tsjs');
  assert.deepEqual(tsjs.languages.typescriptreact, ['.tsx']);
  assert.deepEqual(tsjs.languages.javascriptreact, ['.jsx']);
  assert.ok(CATALOG.find(item => item.id === 'python').markers.includes('pyrightconfig.json'));
  for (const language of CATALOG) for (const server of language.servers) {
    assert.equal(typeof server.installAdvice, 'string');
    assert.ok(server.installAdvice.length > 0);
  }
});

test('项目发现：多 module、唯一可用计划、多候选选择与缺失只给建议', async t => {
  const workspace = await fixture(t);
  const first = await marker(workspace, 'services/a', 'go.mod', 'module a\n');
  const second = await marker(workspace, 'services/b', 'go.mod', 'module b\n');
  const command = await executable(path.join(first, 'node_modules/.bin/gopls'));
  const result = await discoverWorkspace({ workspace, env: { PATH: '' }, languages: ['go'] });

  assert.equal(result.version, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(result.projects.map(item => item.root).sort(), [first, second].sort());
  assert.deepEqual(result.executables, [{ serverId: 'gopls', command: 'gopls', path: command, source: 'workspace' }]);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].status, 'ready');
  assert.equal(result.plans[0].command, command);
  assert.deepEqual(result.plans[0].roots, [first, second].sort());

  const choiceWorkspace = await fixture(t);
  const firstBin = path.join(choiceWorkspace, 'bin-one');
  const secondBin = path.join(choiceWorkspace, 'bin-two');
  await marker(choiceWorkspace, 'web', 'package.json', '{}');
  const firstCandidate = await executable(path.join(firstBin, 'typescript-language-server'));
  const secondCandidate = await executable(path.join(secondBin, 'typescript-language-server'));

  const choice = await discoverWorkspace({
    workspace: choiceWorkspace,
    env: { PATH: `${firstBin}${path.delimiter}${secondBin}` },
    languages: ['tsjs'],
  });
  assert.equal(choice.plans[0].status, 'needs-choice');
  assert.equal(Object.hasOwn(choice.plans[0], 'command'), false);
  assert.deepEqual(choice.plans[0].candidates, [firstCandidate, secondCandidate].sort());
  assert.ok(choice.plans[0].candidates.every(candidate => choice.executables.some(item => item.path === candidate)));

  const missingWorkspace = await fixture(t);
  await marker(missingWorkspace, 'native', 'CMakeLists.txt');
  const missing = await discoverWorkspace({ workspace: missingWorkspace, env: { PATH: '' }, platform: 'win32', languages: ['cpp'] });
  assert.equal(missing.plans[0].status, 'missing');
  assert.equal(typeof missing.plans[0].installAdvice, 'string');
  assert.equal(Object.hasOwn(missing.plans[0], 'command'), false);
});

test('扫描不跟随目录符号链接，marker 必须是普通文件', async t => {
  const workspace = await fixture(t);
  const outside = await fixture(t);
  await marker(workspace, 'src/real', 'Cargo.toml');
  await marker(workspace, '.git/hidden', 'Cargo.toml');
  await marker(workspace, 'node_modules/pkg', 'Cargo.toml');
  await marker(workspace, 'vendor/pkg', 'Cargo.toml');
  await marker(workspace, 'dist/pkg', 'Cargo.toml');
  await marker(workspace, 'build/pkg', 'Cargo.toml');
  await marker(workspace, 'target/pkg', 'Cargo.toml');
  await marker(workspace, 'out/pkg', 'Cargo.toml');
  await marker(workspace, 'cache/pkg', 'Cargo.toml');
  await marker(workspace, 'venv/pkg', 'Cargo.toml');
  await marker(outside, 'escaped', 'Cargo.toml');
  await symlink(path.join(outside, 'escaped'), path.join(workspace, 'linked'));

  const result = await discoverWorkspace({ workspace, env: { PATH: '' }, languages: ['rust'] });
  assert.deepEqual(result.projects.map(item => path.relative(workspace, item.root)), ['src/real']);

  const markerWorkspace = await fixture(t);
  const markerOutside = await fixture(t);
  await mkdir(path.join(markerWorkspace, 'directory/go.mod'), { recursive: true });
  await writeFile(path.join(markerOutside, 'go.mod'), 'module escaped\n');
  await mkdir(path.join(markerWorkspace, 'linked'), { recursive: true });
  await symlink(path.join(markerOutside, 'go.mod'), path.join(markerWorkspace, 'linked/go.mod'));
  const markerResult = await discoverWorkspace({ workspace: markerWorkspace, env: { PATH: '' }, languages: ['go'] });
  assert.deepEqual(markerResult.projects, []);
});

test('PATH 处理：忽略相对段、canonical 去重、128 目录上限与 Windows 包装器', async t => {
  const workspace = await fixture(t);
  const bin = path.join(workspace, 'tools');
  await marker(workspace, 'app', 'pyproject.toml');
  const canonical = await executable(path.join(bin, 'pyright-langserver'));
  await symlink(canonical, path.join(bin, 'pyright-link'));
  await mkdir(path.join(workspace, 'relative-bin'), { recursive: true });
  await executable(path.join(workspace, 'relative-bin', 'pyright-langserver'));

  const result = await discoverWorkspace({
    workspace,
    env: { PATH: `relative-bin${path.delimiter}${bin}${path.delimiter}${bin}` },
    languages: ['python'],
  });
  assert.deepEqual(result.executables.map(item => item.path), [canonical]);
  assert.ok(result.executables.every(item => path.isAbsolute(item.path)));

  const cappedWorkspace = await fixture(t);
  await marker(cappedWorkspace, 'app', 'pyrightconfig.json');
  const directories = Array.from({ length: 129 }, (_, index) => path.join(cappedWorkspace, `bin-${index}`));
  await executable(path.join(directories[128], 'pyright-langserver'));
  const capped = await discoverWorkspace({ workspace: cappedWorkspace, env: { PATH: directories.join(path.delimiter) }, languages: ['python'] });
  assert.ok(capped.truncationReasons.includes('maxPathDirectories'));
  assert.deepEqual(capped.executables, []);

  const windowsWorkspace = await fixture(t);
  const windowsBin = path.join(windowsWorkspace, 'bin');
  await marker(windowsWorkspace, 'web', 'package.json', '{}');
  await executable(path.join(windowsBin, 'typescript-language-server.cmd'));
  await executable(path.join(windowsBin, 'typescript-language-server.bat'));
  const windows = await discoverWorkspace({ workspace: windowsWorkspace, env: { PATH: windowsBin }, platform: 'win32', languages: ['tsjs'] });
  assert.deepEqual(windows.executables, []);
  assert.equal(windows.plans[0].status, 'missing');
});

test('扫描限制：截断原因、硬上限与 AbortSignal', async t => {
  const depthWorkspace = await fixture(t);
  await marker(depthWorkspace, 'a/b', 'go.mod');
  const depth = await discoverWorkspace({ workspace: depthWorkspace, env: { PATH: '' }, languages: ['go'], limits: { maxDepth: 1 } });
  assert.equal(depth.complete, false);
  assert.ok(depth.truncationReasons.includes('maxDepth'));
  assert.equal(depth.projects.length, 0);

  const directoryWorkspace = await fixture(t);
  await mkdir(path.join(directoryWorkspace, 'a'));
  await mkdir(path.join(directoryWorkspace, 'b'));
  const directories = await discoverWorkspace({ workspace: directoryWorkspace, env: { PATH: '' }, languages: ['go'], limits: { maxDirectories: 1 } });
  assert.ok(directories.truncationReasons.includes('maxDirectories'));

  const projectWorkspace = await fixture(t);
  await marker(projectWorkspace, 'a', 'go.mod');
  await marker(projectWorkspace, 'b', 'go.mod');
  const projects = await discoverWorkspace({ workspace: projectWorkspace, env: { PATH: '' }, languages: ['go'], limits: { maxProjects: 1 } });
  assert.ok(projects.truncationReasons.includes('maxProjects'));
  assert.equal(projects.projects.length, 1);

  const limitsWorkspace = await fixture(t);
  await assert.rejects(discoverWorkspace({ workspace: limitsWorkspace, limits: { maxDepth: 33 } }), /maxDepth/);
  await assert.rejects(discoverWorkspace({ workspace: limitsWorkspace, limits: { maxDirectories: 100001 } }), /maxDirectories/);
  await assert.rejects(discoverWorkspace({ workspace: limitsWorkspace, limits: { maxProjects: 4097 } }), /maxProjects/);
  await assert.rejects(discoverWorkspace({ workspace: limitsWorkspace, limits: { deadlineMs: 30001 } }), /deadlineMs/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverWorkspace({ workspace: limitsWorkspace, signal: controller.signal }), error => error.name === 'AbortError');
});

test('扫描边界：工作区 realpath 不逃逸，且实现不引入 child_process', async t => {
  const parent = await fixture(t);
  const actual = await marker(parent, 'actual/project', 'go.mod');
  const alias = path.join(parent, 'alias');
  await symlink(path.join(parent, 'actual'), alias);
  const result = await discoverWorkspace({ workspace: alias, env: { PATH: '' }, languages: ['go'] });
  assert.equal(result.projects[0].root, actual);
  assert.ok(result.projects.every(project => {
    const relative = path.relative(path.join(parent, 'actual'), project.root);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }));

  const source = await readFile(fileURLToPath(new URL('../src/discovery.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /node:child_process|from\s+['"]child_process['"]|\bspawn\s*\(|\bexec(?:File)?\s*\(/);
  assert.doesNotMatch(source, /--version|\swhich\s/);
});