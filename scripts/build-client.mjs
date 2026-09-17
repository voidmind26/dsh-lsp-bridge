import { copyFile, readFile, writeFile } from 'node:fs/promises';

const source = new URL('../src/client.js', import.meta.url);
const output = new URL('../lib/client.js', import.meta.url);
const text = await readFile(source, 'utf8');
if (!text.startsWith("window.__ModuleLoader__.load({\n  id: 'dsh-lsp-bridge',")) {
  throw new Error('客户端源文件不符合 dsh-lsp-bridge ModuleLoader 契约');
}
await copyFile(source, output);
// 统一结尾换行，生成结果可复现。
const built = await readFile(output, 'utf8');
await writeFile(output, built.replace(/\s*$/, '\n'));
