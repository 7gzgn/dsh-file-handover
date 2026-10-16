/**
 * dsh-file-handover · plan —— 纯逻辑层：参数体检、命令构造、结果解析、人话渲染。
 *
 * 这一层不碰文件系统以外的世界（只有"文件在不在"这种只读检查），
 * 真正的 GUI 动作全在 `handover.ps1` 里 —— 所以这一层能在沙箱里反复跑。
 *
 * 铁律（来自抖音投稿页的实战）：
 *   - **目标必须显式**：要交给哪个窗口由调用方说清，绝不"找最像的那个对话框"；
 *   - **每步都要回读**：填完必须读回来比对，不一致就重来（不是"发出去就当成了"）；
 *   - **失败要带现场**：不能只说 not-found，要把"看到了哪些候选窗口"带回来。
 *
 * @module dsh-file-handover/plan
 */

import { isAbsolute } from 'node:path';

/** 默认等对话框的时间（实测点击到弹窗可达 15 秒以上）。 */
export const DEFAULT_TIMEOUT_SEC = 30;

/** 默认的"文件名输入框"自动化 id（Windows 通用文件对话框的约定值）。 */
export const DEFAULT_FILE_INPUT_AUTOMATION_ID = '1148';

/** 默认的"确认"按钮自动化 id（1 = 打开 / 保存）。 */
export const DEFAULT_CONFIRM_AUTOMATION_ID = '1';

/** 默认的确认按钮自动化 id（2 = 取消），供"取消/清理"场景用。 */
export const CANCEL_AUTOMATION_ID = '2';

/** 默认最大尝试次数（设值 → 回读 → 不一致就重来）。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 校验输入。**必填项一个都不能少，不做补全与猜测。**
 * @param {object} input 参数
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
export function validateInput(input = {}) {
  const errors = [];
  const path = input.path;
  if (typeof path !== 'string' || path.trim() === '') {
    errors.push('path 必填：要交付的本地文件**绝对路径**');
  } else if (!isAbsolute(path)) {
    errors.push(`path 必须是绝对路径（不许靠当前目录猜）：${path}`);
  }
  if (input.expectTitle !== undefined && typeof input.expectTitle !== 'string') {
    errors.push('expectTitle 必须是字符串（不填 = 不按标题过滤，只认结构）');
  }
  if (input.timeoutSec !== undefined && (!Number.isFinite(input.timeoutSec) || input.timeoutSec <= 0)) {
    errors.push('timeoutSec 必须是正数（秒）');
  }
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
    errors.push('maxAttempts 必须是 ≥1 的整数');
  }
  if (input.dialogAutomationId !== undefined && !/^\d+$/.test(String(input.dialogAutomationId))) {
    errors.push('dialogAutomationId 必须是数字字符串（Windows 文件对话框的约定是 1148）');
  }
  if (input.confirmAutomationId !== undefined && !/^\d+$/.test(String(input.confirmAutomationId))) {
    errors.push('confirmAutomationId 必须是数字字符串（打开=1 / 取消=2）');
  }
  return errors;
}

/**
 * 检查要交付的文件在不在、是不是文件。
 * @param {string} path 绝对路径
 * @param {object} [deps] 依赖（测试注入 statImpl）
 * @returns {Promise<{ok:boolean, reason?:string, size?:number}>} 结论
 */
export async function checkFile(path, deps = {}) {
  const stat = deps.statImpl ?? (await import('node:fs/promises')).stat;
  try {
    const info = await stat(path);
    if (info.isFile() !== true) return { ok: false, reason: '路径存在，但不是文件（目录？）' };
    return { ok: true, size: info.size };
  } catch (err) {
    return { ok: false, reason: `文件不存在或读不到：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 构造传给 PowerShell 的参数数组（顺序稳定，便于测试断言）。
 * @param {object} input 参数
 * @returns {string[]} 参数
 */
export function buildPsArgs(input = {}) {
  const args = [
    '-Path', String(input.path),
    '-TimeoutSec', String(input.timeoutSec ?? DEFAULT_TIMEOUT_SEC),
    '-FileNameAutomationId', String(input.dialogAutomationId ?? DEFAULT_FILE_INPUT_AUTOMATION_ID),
    '-ConfirmAutomationId', String(input.confirmAutomationId ?? DEFAULT_CONFIRM_AUTOMATION_ID),
    '-MaxAttempts', String(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  ];
  if (typeof input.expectTitle === 'string' && input.expectTitle !== '') {
    args.push('-ExpectTitle', input.expectTitle);
  }
  if (input.dryRun === true) args.push('-DryRun');
  if (input.click === false) args.push('-NoConfirm');
  return args;
}

/**
 * 构造完整的 PowerShell 调用（脚本路径 + 参数）。
 * @param {object} input 参数
 * @param {object} opts 选项 `{ scriptPath, powershell }`
 * @returns {{command:string, args:string[]}} 调用
 */
export function buildPsCommand(input, { scriptPath, powershell = 'powershell.exe' } = {}) {
  return {
    command: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...buildPsArgs(input)],
  };
}

/**
 * 从 stdout 里取出脚本的 JSON 结果（容忍前面混进的杂音）。
 * @param {string} stdout 标准输出
 * @returns {object|null} 结果或 null
 */
export function parseHandoverResult(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    /* 往下找最后一行 JSON */
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

/** 把失败归类成人话（供调用方决定下一步）。 */
export function classifyFailure(result) {
  if (result === null || result === undefined) return { kind: 'no-output', hint: '脚本没有输出结果（可能根本没跑起来）' };
  if (result.ok === true) return { kind: 'ok', hint: '' };
  const error = String(result.error ?? '');
  if (error.startsWith('dialog-not-found')) {
    return {
      kind: 'no-dialog',
      hint: '超时都没等到文件对话框 —— 先确认"打开文件"的入口真的被点到了（程序化 click 不会弹窗，要真实点击）',
    };
  }
  if (error.includes('no-') && error.includes('automationId')) {
    return { kind: 'no-file-input', hint: '对话框找到了，但里面没有文件名输入框 —— 可能不是文件对话框，或结构不常见' };
  }
  if (error.startsWith('value-mismatch')) {
    return { kind: 'value-rejected', hint: '路径填进去又读回来，对不上（常见于刚激活时吞字符）' };
  }
  if (error.startsWith('value-pattern-unavailable') || error.includes('keyboard')) {
    return { kind: 'no-input-path', hint: '这个对话框既不支持设值、键盘也没送进去' };
  }
  if (error.startsWith('confirm-')) {
    return { kind: 'no-confirm', hint: '路径填好了，但确认按钮点不动' };
  }
  return { kind: 'other', hint: error };
}

/**
 * 把结果渲染成给模型看的一段话。
 * @param {object} result 脚本结果（或编排层包装）
 * @returns {string} 文本
 */
export function renderResult(result) {
  if (result === null || result === undefined) return 'handover_file：**没有拿到结果**（脚本没输出）。';
  const lines = [];
  const head = result.dryRun === true ? '🧪 探测（不动手）' : '🤝 递文件';
  lines.push(`${head}｜${result.ok === true ? '成功' : '未完成'}`);
  lines.push(`  · 文件：${result.path ?? '?'}${result.fileSize !== undefined ? `（${result.fileSize} 字节）` : ''}`);
  if (result.dialog) {
    lines.push(`  · 对话框：hwnd ${result.dialog.hwnd ?? '?'}｜pid ${result.dialog.pid ?? '?'}｜标题 “${result.dialog.title ?? ''}”`);
  }
  if (Array.isArray(result.attempts) && result.attempts.length > 0) {
    lines.push('  · 尝试：');
    for (const a of result.attempts) {
      const tail = a.matched === true ? '✅ 一致' : (a.error ? `❌ ${a.error}` : `❌ 读回是 “${a.actual ?? ''}”`);
      lines.push(`      #${a.attempt} ${a.method}：${tail}`);
    }
  }
  if (result.confirmed === true) lines.push('  · 已点确认（打开/保存）');
  if (Array.isArray(result.seen) && result.seen.length > 0) {
    lines.push('  · 看到过的候选窗口：');
    for (const s of result.seen) {
      lines.push(`      hwnd ${s.hwnd}｜pid ${s.pid}｜“${s.title ?? ''}”｜有文件名框=${s.hasFileInput}`);
    }
  }
  if (result.ok !== true) {
    const { kind, hint } = classifyFailure(result);
    lines.push(`  · 卡在哪：${kind}${hint ? ` —— ${hint}` : ''}`);
  } else if (result.dryRun === true) {
    lines.push('  · 探测模式：什么都没填。确认结构和目标无误后，再不带 dryRun 调一次。');
  }
  return lines.join('\n');
}
