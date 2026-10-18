/**
 * dsh-file-handover · handover —— Node 侧编排：校验 → 起 PowerShell → 解析 → 归档结果。
 *
 * 为什么把 GUI 动作交给 PowerShell：Node 没有内置的 Win32 / UI Automation 绑定，
 * 而原生模块（ffi / winax）不能塞进一个纯 JS 插件。PowerShell 是 Windows 上
 * **唯一不需要额外依赖**就能调 UIAutomationClient 的通道。
 *
 * @module dsh-file-handover/handover
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIMEOUT_SEC,
  buildPsCommand,
  checkFiles,
  parseHandoverResult,
  validateInput,
} from './plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 包内自带的干活脚本。 */
export function defaultScriptPath() {
  return join(HERE, 'handover.ps1');
}

/** 用哪个 PowerShell：默认 Windows 自带的 powershell.exe（一切 Windows 都有），可用环境变量覆盖。 */
export function defaultPowerShell() {
  return process.env.DSH_FILE_HANDOVER_POWERSHELL ?? 'powershell.exe';
}

/**
 * 起进程、收 stdout/stderr、带上限。
 * @param {Function} spawnImpl spawn 实现（测试注入）
 * @param {string} command 可执行文件
 * @param {string[]} args 参数
 * @param {number} timeoutMs 上限
 * @returns {Promise<{code:number, stdout:string, stderr:string}>} 结果
 */
function spawnAndCollect(spawnImpl, command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { windowsHide: true, timeout: timeoutMs });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk.toString(); });
    child.on?.('error', (err) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${err instanceof Error ? err.message : String(err)}` });
    });
    child.on?.('close', (code) => {
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
}

/**
 * 走一遍递文件。目标（path）**必须由调用方显式给出**。
 * @param {object} input 参数（见 README）
 * @param {object} [deps] 依赖 `{ spawnImpl, statImpl, scriptPath, powershell }`
 * @returns {Promise<object>} `{ ok, stage, result, code, stdout, stderr, command, errors }`
 */
export async function runHandover(input = {}, deps = {}) {
  const errors = validateInput(input);
  if (errors.length > 0) return { ok: false, stage: 'validate', errors };

  const list = Array.isArray(input.paths) && input.paths.length > 0
    ? input.paths.filter((p) => typeof p === 'string' && p.trim() !== '')
    : [input.path];
  const fileCheck = await checkFiles(list, { statImpl: deps.statImpl });
  if (fileCheck.ok !== true) return { ok: false, stage: 'file', errors: [fileCheck.reason] };

  const scriptPath = deps.scriptPath ?? defaultScriptPath();
  const powershell = deps.powershell ?? defaultPowerShell();
  const timeoutSec = Number.isFinite(input.timeoutSec) ? input.timeoutSec : DEFAULT_TIMEOUT_SEC;
  const { command, args } = buildPsCommand(input, { scriptPath, powershell });

  // 脚本自己按秒轮询等对话框；这里只做"比它更宽"的硬上限，防止它卡死。
  const spawnResult = await spawnAndCollect(
    deps.spawnImpl ?? nodeSpawn,
    command,
    args,
    (timeoutSec + 20) * 1000,
  );

  const parsed = parseHandoverResult(spawnResult.stdout);
  const result = parsed === null ? null : { ...parsed, fileSize: fileCheck.size, files: fileCheck.files };
  return {
    ok: spawnResult.code === 0 && result?.ok === true,
    stage: 'run',
    result,
    code: spawnResult.code,
    stdout: spawnResult.stdout,
    stderr: spawnResult.stderr,
    command: [command, ...args].join(' '),
    errors: [],
  };
}

/**
 * 只探测：路径检查 + 看当前有没有可用的文件对话框（不动它）。
 * @param {object} input 参数
 * @param {object} [deps] 依赖
 * @returns {Promise<object>} 同 runHandover，但脚本以 dryRun 模式跑
 */
export async function probeHandover(input = {}, deps = {}) {
  return runHandover({ ...input, dryRun: true }, deps);
}
