import { access, lstat, opendir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { CATALOG } from './catalog.js';

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 6, maxDirectories: 5000, maxProjects: 256, deadlineMs: 2000 });
const HARD_LIMITS = Object.freeze({ maxDepth: 32, maxDirectories: 100000, maxProjects: 4096, deadlineMs: 30000 });
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'cache', '.cache', 'venv', '.venv']);
/** 项目本地可执行文件目录：扫描会话工作区与解析配置项命令时共用同一份清单。 */
export const WORKSPACE_BIN_DIRECTORIES = Object.freeze(['node_modules/.bin', '.venv/bin', 'venv/bin', '.cargo/bin']);
const MAX_DIRECTORY_ENTRIES = 100000;

const inside = (base, target) => {
  const relative = path.relative(base, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function abortError() {
  const error = new Error('自动发现已取消');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function normalizedLimits(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('limits 必须是对象');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new TypeError(`未知限制项：${key}`);
  const result = { ...DEFAULT_LIMITS };
  for (const [key, maximum] of Object.entries(HARD_LIMITS)) {
    const value = input[key] ?? result[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${key} 必须是 1 到 ${maximum} 之间的整数`);
    result[key] = value;
  }
  return result;
}

function selectedCatalog(languages) {
  if (languages === undefined) return CATALOG;
  if (!Array.isArray(languages) || languages.some(value => typeof value !== 'string' || !value)) throw new TypeError('languages 必须是非空字符串数组');
  const requested = new Set(languages);
  const selected = CATALOG.filter(language => requested.has(language.id));
  const known = new Set(CATALOG.map(language => language.id));
  for (const language of requested) if (!known.has(language)) throw new TypeError(`未知语言：${language}`);
  return selected;
}

function commonDirectories(platform, env) {
  const home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : null;
  if (platform === 'win32') {
    return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(value => typeof value === 'string' && path.isAbsolute(value));
  }
  const result = ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', '/opt/local/bin'];
  if (home) result.push(path.join(home, 'go', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.local', 'bin'));
  return result;
}

function pathDirectories(env, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const value = String(env.PATH ?? '');
  const directories = new Set();
  let offset = 0;
  while (offset <= value.length) {
    let end = value.indexOf(delimiter, offset);
    if (end === -1) end = value.length;
    const directory = value.slice(offset, end);
    if (path.isAbsolute(directory)) {
      if (!directories.has(directory) && directories.size === 128) return { directories: [...directories], truncated: true };
      directories.add(directory);
    }
    offset = end + 1;
  }
  return { directories: [...directories], truncated: false };
}

function commandNames(command, platform) {
  if (platform !== 'win32' || path.extname(command)) return [command];
  // shell:false 不能直接执行 cmd/bat 包装器，因此 Windows 只接受原生 exe。
  return [`${command}.exe`];
}

async function canonicalExecutable(candidate, workspace, workspaceOnly, signal) {
  checkAbort(signal);
  let canonical;
  try {
    canonical = await realpath(candidate);
    if (!path.isAbsolute(canonical) || (workspaceOnly && !inside(workspace, canonical))) return null;
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return null;
    await access(canonical, constants.X_OK);
    return canonical;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return null;
    throw error;
  }
}

async function scanProjects(workspace, catalog, limits, signal, expired) {
  const markerMap = new Map();
  for (const language of catalog) for (const marker of language.markers) {
    const entries = markerMap.get(marker) ?? [];
    entries.push(language);
    markerMap.set(marker, entries);
  }
  const queue = [{ directory: workspace, depth: 0 }];
  const projects = [];
  const seenProjects = new Set();
  const projectRoots = new Set([workspace]);
  const reasons = new Set();
  let directories = 0;
  let scheduledDirectories = 1;

  scan: while (queue.length) {
    checkAbort(signal);
    if (expired()) { reasons.add('deadline'); break; }
    const current = queue.shift();
    directories++;
    const markerNames = new Set();
    let handle;
    let entryCount = 0;
    try {
      handle = await opendir(current.directory);
      for await (const entry of handle) {
        checkAbort(signal);
        if (expired()) { reasons.add('deadline'); break scan; }
        entryCount++;
        if (entryCount > MAX_DIRECTORY_ENTRIES) { reasons.add('maxEntries'); break; }
        if (markerMap.has(entry.name)) {
          try {
            const metadata = await lstat(path.join(current.directory, entry.name));
            if (metadata.isFile() && !metadata.isSymbolicLink()) markerNames.add(entry.name);
          } catch (error) {
            if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code)) throw error;
          }
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (current.depth >= limits.maxDepth) { reasons.add('maxDepth'); continue; }
        if (scheduledDirectories >= limits.maxDirectories) { reasons.add('maxDirectories'); continue; }
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
        scheduledDirectories++;
      }
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code)) throw error;
    } finally {
      // for-await 会自行关闭；提前跨出循环时也由异步迭代器 return 关闭。
    }
    for (const [marker, languages] of markerMap) {
      if (!markerNames.has(marker)) continue;
      for (const language of languages) {
        const key = `${language.id}\0${current.directory}`;
        if (seenProjects.has(key)) continue;
        if (projects.length >= limits.maxProjects) { reasons.add('maxProjects'); break scan; }
        seenProjects.add(key);
        projectRoots.add(current.directory);
        projects.push({ language: language.id, root: current.directory, markers: language.markers.filter(name => markerNames.has(name)) });
      }
    }
  }
  return { projects, projectRoots: [...projectRoots], reasons, directories };
}

async function discoverExecutables(workspace, catalog, projectRoots, env, platform, signal, expired) {
  const pathResult = pathDirectories(env, platform);
  const externalDirectories = [...new Set([...pathResult.directories, ...commonDirectories(platform, env)])];
  const workspaceDirectories = [];
  for (const root of projectRoots) for (const relative of WORKSPACE_BIN_DIRECTORIES) {
    const candidate = path.resolve(root, relative);
    if (inside(workspace, candidate)) workspaceDirectories.push(candidate);
  }
  const locations = [
    ...externalDirectories.map(directory => ({ directory, source: 'system', workspaceOnly: false })),
    ...[...new Set(workspaceDirectories)].map(directory => ({ directory, source: 'workspace', workspaceOnly: true })),
  ];
  const executables = [];
  const seen = new Set();
  let deadlineReached = false;
  discovery: for (const language of catalog) for (const server of language.servers) for (const location of locations) for (const command of server.commands) for (const filename of commandNames(command, platform)) {
    checkAbort(signal);
    if (expired()) { deadlineReached = true; break discovery; }
    const canonical = await canonicalExecutable(path.join(location.directory, filename), workspace, location.workspaceOnly, signal);
    if (!canonical) continue;
    const key = `${server.id}\0${canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    executables.push({ serverId: server.id, command: command, path: canonical, source: location.source });
  }
  executables.sort((a, b) => a.serverId.localeCompare(b.serverId) || a.path.localeCompare(b.path));
  return { executables, deadlineReached, pathTruncated: pathResult.truncated };
}

function buildPlans(catalog, projects, executables) {
  const rootsByLanguage = new Map();
  for (const project of projects) {
    const roots = rootsByLanguage.get(project.language) ?? [];
    roots.push(project.root);
    rootsByLanguage.set(project.language, roots);
  }
  const plans = [];
  for (const language of catalog) {
    const roots = rootsByLanguage.get(language.id) ?? [];
    if (!roots.length) continue;
    for (const server of language.servers) {
      const candidates = executables.filter(item => item.serverId === server.id).map(item => item.path);
      const base = {
        language: language.id,
        serverId: server.id,
        roots: [...roots].sort(),
        args: [...server.args],
        languages: Object.fromEntries(Object.entries(language.languages).map(([id, extensions]) => [id, [...extensions]])),
        rootMarkers: [...language.markers],
      };
      if (candidates.length === 1) plans.push({ ...base, status: 'ready', command: candidates[0] });
      else if (candidates.length > 1) plans.push({ ...base, status: 'needs-choice', candidates });
      else plans.push({ ...base, status: 'missing', installAdvice: server.installAdvice });
    }
  }
  return plans;
}

/**
 * 只读取文件系统并返回配置建议；不会执行进程、版本命令，也不会写入任何配置。
 */
export async function discoverWorkspace({ workspace, env = process.env, platform = process.platform, limits: inputLimits, languages, signal } = {}) {
  checkAbort(signal);
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new TypeError('workspace 必须是绝对路径');
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new TypeError('env 必须是对象');
  if (typeof platform !== 'string' || !platform) throw new TypeError('platform 必须是非空字符串');
  const limits = normalizedLimits(inputLimits);
  const catalog = selectedCatalog(languages);
  const started = Date.now();
  const expired = () => Date.now() - started >= limits.deadlineMs;
  const canonicalWorkspace = await realpath(workspace);
  if (!(await lstat(canonicalWorkspace)).isDirectory()) throw new TypeError('workspace 必须是目录');
  checkAbort(signal);

  const scanned = await scanProjects(canonicalWorkspace, catalog, limits, signal, expired);
  const found = await discoverExecutables(canonicalWorkspace, catalog, scanned.projectRoots, env, platform, signal, expired);
  if (found.deadlineReached) scanned.reasons.add('deadline');
  if (found.pathTruncated) scanned.reasons.add('maxPathDirectories');
  const truncationReasons = [...scanned.reasons].sort();
  return {
    version: 1,
    complete: truncationReasons.length === 0,
    truncationReasons,
    executables: found.executables,
    projects: scanned.projects,
    plans: buildPlans(catalog, scanned.projects, found.executables),
  };
}
