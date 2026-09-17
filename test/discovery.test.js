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

test('发现多个 module、工作区本地命令并形成唯一可用计划', async t => {
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
});

test('跳过构建目录、依赖目录以及目录符号链接', async t => {
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
});

test('marker 必须是普通文件，拒绝目录和符号链接', async t => {
  const workspace = await fixture(t);
  const outside = await fixture(t);
  await mkdir(path.join(workspace, 'directory/go.mod'), { recursive: true });
  await writeFile(path.join(outside, 'go.mod'), 'module escaped\n');
  await mkdir(path.join(workspace, 'linked'), { recursive: true });
  await symlink(path.join(outside, 'go.mod'), path.join(workspace, 'linked/go.mod'));
  const result = await discoverWorkspace({ workspace, env: { PATH: '' }, languages: ['go'] });
  assert.deepEqual(result.projects, []);
});

test('忽略 PATH 相对段，只接受 canonical 绝对普通可执行文件并去重', async t => {
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
});

test('PATH 最多采用 128 个绝对目录并报告截断', async t => {
  const workspace = await fixture(t);
  await marker(workspace, 'app', 'pyrightconfig.json');
  const directories = Array.from({ length: 129 }, (_, index) => path.join(workspace, `bin-${index}`));
  await executable(path.join(directories[128], 'pyright-langserver'));
  const result = await discoverWorkspace({ workspace, env: { PATH: directories.join(path.delimiter) }, languages: ['python'] });
  assert.ok(result.truncationReasons.includes('maxPathDirectories'));
  assert.deepEqual(result.executables, []);
});

test('Windows 不把 cmd/bat 包装器视为可直接执行候选', async t => {
  const workspace = await fixture(t);
  const bin = path.join(workspace, 'bin');
  await marker(workspace, 'web', 'package.json', '{}');
  await executable(path.join(bin, 'typescript-language-server.cmd'));
  await executable(path.join(bin, 'typescript-language-server.bat'));
  const result = await discoverWorkspace({ workspace, env: { PATH: bin }, platform: 'win32', languages: ['tsjs'] });
  assert.deepEqual(result.executables, []);
  assert.equal(result.plans[0].status, 'missing');
});

test('多个可执行候选要求选择且 command 只来自发现结果', async t => {
  const workspace = await fixture(t);
  const firstBin = path.join(workspace, 'bin-one');
  const secondBin = path.join(workspace, 'bin-two');
  await marker(workspace, 'web', 'package.json', '{}');
  const first = await executable(path.join(firstBin, 'typescript-language-server'));
  const second = await executable(path.join(secondBin, 'typescript-language-server'));

  const result = await discoverWorkspace({
    workspace,
    env: { PATH: `${firstBin}${path.delimiter}${secondBin}` },
    languages: ['tsjs'],
  });
  assert.equal(result.plans[0].status, 'needs-choice');
  assert.equal(Object.hasOwn(result.plans[0], 'command'), false);
  assert.deepEqual(result.plans[0].candidates, [first, second].sort());
  assert.ok(result.plans[0].candidates.every(candidate => result.executables.some(item => item.path === candidate)));
});

test('缺失命令只给出安装建议，不伪造 command', async t => {
  const workspace = await fixture(t);
  await marker(workspace, 'native', 'CMakeLists.txt');
  const result = await discoverWorkspace({ workspace, env: { PATH: '' }, platform: 'win32', languages: ['cpp'] });
  assert.equal(result.plans[0].status, 'missing');
  assert.equal(typeof result.plans[0].installAdvice, 'string');
  assert.equal(Object.hasOwn(result.plans[0], 'command'), false);
});

test('深度、目录数与项目数限制产生明确截断原因', async t => {
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
});

test('限制存在硬上限且支持 AbortSignal', async t => {
  const workspace = await fixture(t);
  await assert.rejects(discoverWorkspace({ workspace, limits: { maxDepth: 33 } }), /maxDepth/);
  await assert.rejects(discoverWorkspace({ workspace, limits: { maxDirectories: 100001 } }), /maxDirectories/);
  await assert.rejects(discoverWorkspace({ workspace, limits: { maxProjects: 4097 } }), /maxProjects/);
  await assert.rejects(discoverWorkspace({ workspace, limits: { deadlineMs: 30001 } }), /deadlineMs/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverWorkspace({ workspace, signal: controller.signal }), error => error.name === 'AbortError');
});

test('工作区先 realpath，扫描结果不逃逸工作区', async t => {
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
});

test('自动发现实现不导入 child_process，因而不会 spawn 或执行版本命令', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/discovery.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /node:child_process|from\s+['"]child_process['"]|\bspawn\s*\(|\bexec(?:File)?\s*\(/);
  assert.doesNotMatch(source, /--version|\swhich\s/);
});
