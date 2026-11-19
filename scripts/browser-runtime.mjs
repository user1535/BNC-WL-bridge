// Test-only browser tooling. Application runtime has no Node/Playwright dependency.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
let library;
try {library=await import(process.env.BNC_PLAYWRIGHT_MODULE||'playwright');}
catch(error) {
 if(process.env.BNC_PLAYWRIGHT_MODULE||process.platform!=='win32')throw error;
 const bundled=path.join(process.env.USERPROFILE||'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
 if(!fs.existsSync(bundled))throw error;
 library=await import(pathToFileURL(bundled));
}
export const chromium=library.chromium;
const chrome=process.env.BNC_BROWSER_EXECUTABLE||(process.platform==='win32'?path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'):undefined);
export const launchOptions={headless:true,...(chrome?{executablePath:chrome}:{})};
export function runLocalPython(args,timeout=30000) {
 if(process.platform==='win32') {
  const root=fileURLToPath(new URL('../',import.meta.url)),parts=root.split('\\').filter(Boolean);
  if(!['wsl$','wsl.localhost'].includes(parts[0]))throw new Error('Windows browser tests need a WSL checkout or a Linux test runner');
  const linuxRoot='/'+parts.slice(2).join('/');
  return execFileSync(path.join(process.env.WINDIR||'C:/Windows','System32/wsl.exe'),['-d',process.env.BNC_WSL_DISTRO||parts[1],'--cd',linuxRoot,'--exec',process.env.BNC_PYTHON||'python3',...args],{timeout});
 }
 return execFileSync(process.env.BNC_PYTHON||'python3',args,{cwd:fileURLToPath(new URL('../',import.meta.url)),timeout});
}
