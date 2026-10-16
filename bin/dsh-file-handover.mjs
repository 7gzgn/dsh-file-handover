#!/usr/bin/env node
/**
 * dsh-file-handover · CLI —— 不开会话也能递文件。
 *
 *   dsh-file-handover handover --path <绝对路径> [--timeout 30] [--expect-title Open] [--no-click]
 *   dsh-file-handover probe    --path <绝对路径> [--timeout 10]
 *
 * 退出码：0 = 文件已交付（或探测通过）；1 = 未完成；2 = 用法错误。
 *
 * @module dsh-file-handover/bin
 */

import { classifyFailure, renderResult } from '../lib/plan.js';
import { runHandover } from '../lib/handover.js';

/** 极简参数解析。 */
function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else {
      out._.push(token);
    }
  }
  return out;
}

const USAGE = `dsh-file-handover —— 把本地文件交给系统"打开文件"对话框

用法：
  dsh-file-handover handover --path <绝对路径> [--timeout 30] [--expect-title <标题前缀>] [--no-click] [--attempts 3]
  dsh-file-handover probe    --path <绝对路径> [--timeout 10]

说明：
  · 先做触发动作（真实点击"上传/打开"按钮），再跑它 —— 它只负责"等对话框 → 填路径 → 回读 → 确认"。
  · 目标必须显式：path 必须是绝对路径；它不会自己去找"最像的对话框"。
  · 默认不按标题过滤（只认结构 automation id），需要时用 --expect-title 显式给。
`;

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0] ?? 'handover';

  if (cmd === 'help' || argv.help === true) {
    console.log(USAGE);
    return 0;
  }

  if (cmd !== 'handover' && cmd !== 'probe') {
    console.error(`未知子命令：${cmd}\n\n${USAGE}`);
    return 2;
  }

  if (typeof argv.path !== 'string' || argv.path === '') {
    console.error(`❌ --path 必填（要交付的文件绝对路径）\n\n${USAGE}`);
    return 2;
  }

  const run = await runHandover({
    path: argv.path,
    timeoutSec: argv.timeout === undefined ? undefined : Number(argv.timeout),
    expectTitle: typeof argv['expect-title'] === 'string' ? argv['expect-title'] : undefined,
    maxAttempts: argv.attempts === undefined ? undefined : Number(argv.attempts),
    dryRun: cmd === 'probe',
    click: argv['no-click'] !== true,
  });

  if (run.stage === 'validate' || run.stage === 'file') {
    for (const e of run.errors ?? []) console.error(`❌ ${e}`);
    return 2;
  }

  console.log(renderResult(run.result));
  if (run.result === null) {
    if (run.stderr) console.error(`脚本 stderr：${String(run.stderr).slice(0, 800)}`);
    if (run.command) console.error(`命令：${run.command}`);
    return 1;
  }
  if (run.result.ok !== true) {
    console.log(`  归类：${classifyFailure(run.result).kind}`);
  }
  return run.ok === true ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
