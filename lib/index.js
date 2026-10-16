/**
 * dsh-file-handover —— 宿主入口。
 *
 * 一句话：**把本地文件交给"打开文件"对话框** —— 网页上传、微信发文件、PS 打开，
 * 那些"要点一下、再在系统对话框里选文件"的地方，都由它代劳。
 *
 * 为什么需要它：agent 会点按钮、会打字，但**不会在文件选择器里选文件** ——
 * 那是 GUI 自动化的最后一块空白（也是"发抖音"卡住的地方）。
 *
 * 安全边界（README 里也写着）：
 *   - **目标必须显式**：交给哪个窗口/进程由调用方指定，绝不"找最像的那个"；
 *   - **每步回读**：填进去必须读回来比对，不一致就重来；
 *   - **失败带现场**：把看到过的候选窗口、每次尝试的实际值都带回来；
 *   - **默认不猜标题**：只认结构（automation id），标题过滤要显式给。
 *
 * @module dsh-file-handover
 */

import {
  CANCEL_AUTOMATION_ID,
  DEFAULT_CONFIRM_AUTOMATION_ID,
  DEFAULT_FILE_INPUT_AUTOMATION_ID,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_SEC,
  renderResult,
} from './plan.js';
import { runHandover } from './handover.js';

/** 插件身份。 */
export const name = 'dsh-file-handover';

/** 需要宿主提供的服务（拿不到就退化，不报错）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 208;
const TOOL_TIMEOUT_MS = 180000;

/** 面向模型的公告（常驻那一段）。 */
export const HANDOVER_GUIDANCE = [
  '本机已安装 **dsh-file-handover（递文件）**：`handover_file` 把本地文件交给系统"打开文件"对话框 —— 网页上传、微信发文件、Photoshop 打开，凡是"点一下、再在对话框里选文件"的地方都能用它代劳。',
  '**它不会自己去找对话框**：目标要由你说清（先做触发动作，比如真实点击页面的"上传"按钮），它只负责"等对话框 → 填路径 → 回读校验 → 点确认"。',
  '**每步都回读**：填进去会读回来比对，不一致就换方法或重来（键盘输入到刚激活的窗口会丢前几个字符，这是已知现象，不是它没干活）。',
  '**失败会带现场**：它会把看到过的候选窗口和每次尝试的实际值一起返回 —— 别只读"失败"两个字，现场里有原因。',
  `可选参数：timeoutSec（默认 ${DEFAULT_TIMEOUT_SEC} 秒，弹窗可能有延迟）、dryRun（只探测不动手）、expectTitle（**显式**按标题过滤，默认不用标题）、maxAttempts（默认 ${DEFAULT_MAX_ATTEMPTS}）、click=false（只填不点确认）。`,
  '典型用法：点上传 → `handover_file` 递文件 → 用浏览器工具确认页面真的收到了那个文件。',
].join('\n');

/** 动态取 defineTool：宿主里有就用真的，单测/CLI 场景退化成恒等。 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行 */
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} [config] 插件配置
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const disposers = [];

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    disposers.push(ctx.tools.register(defineTool({
      name: 'handover_file',
      description: [
        '把一个本地文件交给系统"打开文件"对话框（网页上传、微信发文件、PS 打开都行）。',
        '用法：先做触发动作（例如真实点击页面的"上传"按钮），再调它 —— 它会等对话框出现、填好路径、**读回来核对**、点确认。',
        '**目标必须显式**：它不会自己去找"最像的对话框"；path 必须是绝对路径。',
        '每步回读、失败带现场（看到过哪些候选窗口 + 每次尝试的实际值）。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        path: { type: 'string', description: '要交付的本地文件**绝对路径**（必填）' },
        timeoutSec: { type: 'number', description: `等对话框出现的秒数（默认 ${DEFAULT_TIMEOUT_SEC}；实测弹窗延迟可 >15s）` },
        dryRun: { type: 'boolean', description: 'true = 只探测（找对话框、报结构），不填不点' },
        expectTitle: { type: 'string', description: '显式按标题前缀过滤对话框标题（默认空 = 不按标题，只认结构）' },
        dialogAutomationId: { type: 'string', description: `文件名输入框的自动化 id（默认 ${DEFAULT_FILE_INPUT_AUTOMATION_ID}）` },
        confirmAutomationId: { type: 'string', description: `确认按钮的自动化 id（默认 ${DEFAULT_CONFIRM_AUTOMATION_ID}；取消是 ${CANCEL_AUTOMATION_ID}）` },
        maxAttempts: { type: 'number', description: `填值+回读的最大轮数（默认 ${DEFAULT_MAX_ATTEMPTS}）` },
        click: { type: 'boolean', description: 'false = 只填路径、不点确认（想自己确认时用）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            data: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const d = value.data ?? {};
          if (d.stage === 'validate' || d.stage === 'file') {
            return [{ type: 'text', text: `handover_file｜未开始：\n  ${(d.errors ?? []).join('\n  ')}` }];
          }
          const lines = [renderResult(d.result ?? null)];
          if (d.result === null && d.stderr) lines.push(`  脚本 stderr：${String(d.stderr).slice(0, 400)}`);
          if (d.result === null && d.command) lines.push(`  命令：${d.command}`);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const a = args ?? {};
        try {
          const data = await runHandover({
            path: a.path,
            timeoutSec: a.timeoutSec ?? cfg.timeoutSec,
            dryRun: a.dryRun === true,
            expectTitle: a.expectTitle ?? cfg.expectTitle,
            dialogAutomationId: a.dialogAutomationId ?? cfg.dialogAutomationId,
            confirmAutomationId: a.confirmAutomationId ?? cfg.confirmAutomationId,
            maxAttempts: a.maxAttempts ?? cfg.maxAttempts,
            click: a.click !== false,
          });
          return { ok: data.ok === true, data, error: data.ok === true ? undefined : String((data.errors ?? [])[0] ?? data.result?.error ?? '未完成') };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    })));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:file-handover',
      order: SECTION_ORDER,
      text: HANDOVER_GUIDANCE,
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-file-handover: teardown');
  }
}
