#!/usr/bin/env node
/**
 * WorkBuddy / CodeBuddy transcript 格式兼容性检查器
 *
 * 解析 ~/.codebuddy/projects 与 ~/.workbuddy/projects 下最新的 WorkBuddy
 * transcript JSONL，对照 cloudcli 的读取基线（workbuddy-sessions.provider.ts
 * 的 normalizeMessage / readTranscript、同步器、extractUserPrompt），找出
 * 可能因 WorkBuddy 引擎升级而变化的结构（新顶层 type / 新 content block /
 * <user_query> 提取失效 / 事件字段改名等）。
 *
 * 用法：
 *   node check-workbuddy-format.mjs                  # 自动找最新会话
 *   node check-workbuddy-format.mjs <jsonl路径>       # 检查指定会话
 *   node check-workbuddy-format.mjs --all            # 最近 5 个会话
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/**
 * 与 getWorkbuddySessionRoots 同逻辑：默认根 + 环境变量覆盖。
 */
function sessionRoots() {
  const explicitProjectsRoot = process.env.WORKBUDDY_PROJECTS_ROOT?.trim();
  if (explicitProjectsRoot) {
    return [explicitProjectsRoot];
  }
  const explicitConfigDir = process.env.CODEBUDDY_CONFIG_DIR?.trim()
    || process.env.WORKBUDDY_CONFIG_DIR?.trim();
  if (explicitConfigDir) {
    return [path.join(explicitConfigDir, 'projects')];
  }
  return [
    path.join(os.homedir(), '.codebuddy', 'projects'),
    path.join(os.homedir(), '.workbuddy', 'projects'),
  ];
}

/**
 * 项目读取并产生消息的顶层 type（normalizeMessage + readTranscript）。
 * `message` 是主载体（role/content 在顶层）；function_call / function_call_result
 * 由 normalizeMessage 映射为 tool_use / tool_result。
 */
const KNOWN_MESSAGE_TYPES = new Set([
  'message', 'function_call', 'function_call_result',
]);

/**
 * 项目读取但不产生聊天消息的事件（同步器消费）。
 */
const KNOWN_METADATA_TYPES = new Map([
  ['ai-title', '会话名来源（同步器 aiTitle + sessionId）'],
]);

/**
 * 已评估无影响：normalizeMessage 返回空，readTranscript 跳过，不展示。
 */
const KNOWN_NOT_READ_TYPES = new Map([
  ['reasoning', '含 content/rawContent，normalize 返回 []，readTranscript 跳过'],
  ['file-history-snapshot', '文件历史快照，跳过'],
  ['resend-fork-notice', 'fork 编辑元数据，normalize 返回 []；所在会话通常是 transient workspace 被同步器跳过'],
  ['system', 'subtype.startsWith(task_) 读作 task_notification；subtype=init 是实时初始化；其他 subtype normalize 返回 []'],
]);

/**
 * message.content 数组元素类型（readTranscript 认知）。
 * user: input_text（extractUserPrompt 提取 <user_query>）+ image_blob_ref（还原图片附件）+ tool_result；
 * assistant: output_text（text）+ reasoning_text（thinking）+ tool_use。
 */
const KNOWN_BLOCK_TYPES = new Set([
  'input_text', 'image_blob_ref', 'output_text', 'reasoning_text', 'tool_use', 'tool_result',
]);

/**
 * system 事件已知 subtype 前缀/值。
 */
const KNOWN_SYSTEM_SUBTYPES = {
  taskPrefix: 'task_', // task_started / task_update / task_notification → task_notification 卡片
  init: 'init',        // 实时初始化事件
};

/** 与同步器同逻辑：transient workspace 正则在 cwd 上的匹配。 */
const TRANSIENT_WORKSPACE_RE = /\/WorkBuddy\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

/** 与 extractUserPrompt 同逻辑：提取 <user_query> 内的真实输入。 */
function extractUserQuery(text) {
  const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return match?.[1]?.trim() || '';
}

async function analyzeSession(filePath) {
  const typeCounts = new Map();
  const blockTypes = new Map();
  const roleCounts = new Map();
  const userQueryCheck = { inputTexts: 0, withTag: 0, withReminderOnly: 0, extractedEmpty: 0, plain: 0 };
  const functionCallIssues = [];
  const systemSubtypes = new Map();
  const badLines = { total: 0, skipped: 0 };
  let isTransientWorkspace = false;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    badLines.total += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      badLines.skipped += 1;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const type = entry.type ?? '?';
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

    if (type === 'message') {
      const role = entry.role;
      if (role) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      const blocks = Array.isArray(entry.content) ? entry.content : [];
      for (const block of blocks) {
        if (block && typeof block.type === 'string') {
          blockTypes.set(block.type, (blockTypes.get(block.type) ?? 0) + 1);
        }
      }
      // 用户输入提取检查：input_text 是否带 <user_query>，提取是否成功。
      if (role === 'user') {
        for (const block of blocks) {
          if (block?.type !== 'input_text' || typeof block.text !== 'string') continue;
          userQueryCheck.inputTexts += 1;
          const text = block.text;
          if (text.includes('<user_query>')) {
            userQueryCheck.withTag += 1;
            if (!extractUserQuery(text)) userQueryCheck.extractedEmpty += 1;
          } else if (text.includes('<system-reminder') || text.includes('user-context')) {
            userQueryCheck.withReminderOnly += 1;
          } else {
            userQueryCheck.plain += 1;
          }
        }
      }
      if (typeof entry.cwd === 'string' && TRANSIENT_WORKSPACE_RE.test(entry.cwd)) {
        isTransientWorkspace = true;
      }
    }

    if (type === 'function_call') {
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        functionCallIssues.push(`function_call 缺 name（id=${entry.id ?? '?'}）`);
      }
      if (typeof entry.callId !== 'string' && typeof entry.id !== 'string') {
        functionCallIssues.push(`function_call 缺 callId/id（name=${entry.name ?? '?'}）`);
      }
    }
    if (type === 'function_call_result') {
      if (typeof entry.callId !== 'string') {
        functionCallIssues.push('function_call_result 缺 callId');
      }
      if (typeof entry.status !== 'string') {
        functionCallIssues.push('function_call_result 缺 status（isError 判定依赖它）');
      }
    }

    if (type === 'system' && typeof entry.subtype === 'string') {
      const subtype = entry.subtype;
      systemSubtypes.set(subtype, (systemSubtypes.get(subtype) ?? 0) + 1);
      const known = subtype.startsWith(KNOWN_SYSTEM_SUBTYPES.taskPrefix)
        || subtype === KNOWN_SYSTEM_SUBTYPES.init;
      if (!known) {
        functionCallIssues.push(`system 未知 subtype「${subtype}」（仅 task_* 前缀与 init 被项目处理）`);
      }
    }
  }

  return {
    typeCounts, blockTypes, roleCounts, userQueryCheck,
    functionCallIssues, systemSubtypes, badLines, isTransientWorkspace,
  };
}

function findSessionFiles(limit) {
  const files = [];
  for (const root of sessionRoots()) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          // 子代理/工具结果目录，与同步器一致跳过。
          if (name === 'subagents' || name === 'tool-results') continue;
          walk(full);
        } else if (name.endsWith('.jsonl') && !name.startsWith('agent-')) {
          files.push(full);
        }
      }
    };
    walk(root);
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.slice(0, limit);
}

function printReport(filePath, data) {
  const {
    typeCounts, blockTypes, roleCounts, userQueryCheck,
    functionCallIssues, systemSubtypes, badLines, isTransientWorkspace,
  } = data;
  const roots = sessionRoots();
  const rel = roots.map((r) => path.relative(r, filePath)).find((p) => !p.startsWith('..')) ?? filePath;

  console.log('\n=== WorkBuddy transcript 格式兼容性检查 ===\n');
  console.log(`检查文件: ${rel}`);
  console.log(`文件修改时间: ${fs.statSync(filePath).mtime.toISOString()}，共 ${badLines.total} 行`);

  if (badLines.total === 0) {
    console.log('  ⚠️ 空文件（0 行）：WorkBuddy 会为「开始过但未写入」的会话留空 transcript，');
    console.log('    fetchHistory 返回空历史。无内容可检查，跳过后续对照。\n');
    return;
  }
  if (isTransientWorkspace) {
    console.log('  会话类型: transient workspace（cwd 匹配 ~/WorkBuddy/<date>，同步器跳过，不索引展示）');
  }
  if (badLines.skipped > 0) {
    console.log(`  ℹ️ 坏行 ${badLines.skipped} 条已跳过（与 readTranscript 的 JSON.parse 容错一致）`);
  }

  console.log('\n[顶层 type]');
  for (const [type, n] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const tag = KNOWN_MESSAGE_TYPES.has(type)
      ? '项目会渲染'
      : KNOWN_METADATA_TYPES.has(type)
        ? `已读(${KNOWN_METADATA_TYPES.get(type)})`
        : KNOWN_NOT_READ_TYPES.has(type)
          ? `已评估(${KNOWN_NOT_READ_TYPES.get(type)})`
          : '需评估';
    console.log(`  ${String(n).padStart(5)}  ${type}  — ${tag}`);
  }

  console.log('\n[content block 类型]');
  if (blockTypes.size === 0) {
    console.log('  无 content block（message 事件无 content 数组或不存在 message 事件）');
  }
  for (const [block, n] of [...blockTypes.entries()].sort((a, b) => b[1] - a[1])) {
    const tag = KNOWN_BLOCK_TYPES.has(block) ? '项目已适配' : '需评估';
    console.log(`  ${String(n).padStart(5)}  ${block}  — ${tag}`);
  }

  console.log('\n[关键格式点]');
  if (roleCounts.size > 0) {
    const roles = [...roleCounts.entries()].map(([r, n]) => `${r}:${n}`).join(', ');
    console.log(`  ℹ️  message role 分布: ${roles}`);
  }
  for (const type of ['ai-title']) {
    if ((typeCounts.get(type) ?? 0) > 0) {
      console.log(`  ✅ 会话名事件 ${type}: ${typeCounts.get(type)} 条，同步器已适配`);
    }
  }
  if (systemSubtypes.size > 0) {
    const subs = [...systemSubtypes.entries()].map(([s, n]) => `${s}:${n}`).join(', ');
    console.log(`  ℹ️  system subtype: ${subs}`);
  }

  // 用户输入提取报告（各信号独立显示，不互斥）
  const uq = userQueryCheck;
  if (uq.inputTexts > 0) {
    if (uq.withTag > 0) {
      if (uq.extractedEmpty > 0) {
        console.log(`  ⚠️ 用户输入提取: ${uq.extractedEmpty}/${uq.withTag} 个 <user_query> 标签内容为空 — 需确认`);
      } else {
        console.log(`  ✅ 用户输入提取: ${uq.withTag}/${uq.inputTexts} 个 input_text 带 <user_query>，全部提取成功`);
      }
    }
    if (uq.withReminderOnly > 0) {
      console.log(`  ⚠️ 用户输入提取: ${uq.withReminderOnly}/${uq.inputTexts} 个 input_text 只有 <system-reminder> 注入、无 <user_query> 标签 — 这些 turn 会显示注入上下文而非用户输入`);
    }
    if (uq.plain > 0) {
      console.log(`  ℹ️ 用户输入提取: ${uq.plain} 个纯文本 input_text（旧格式，extractUserPrompt 原样返回）`);
    }
  }

  console.log('\n[与项目读取逻辑对照]');
  const unclassifiedTypes = [...typeCounts.entries()]
    .filter(([type]) => !KNOWN_MESSAGE_TYPES.has(type)
      && !KNOWN_METADATA_TYPES.has(type)
      && !KNOWN_NOT_READ_TYPES.has(type))
    .sort((a, b) => b[1] - a[1]);
  const unclassifiedBlocks = [...blockTypes.entries()]
    .filter(([block]) => !KNOWN_BLOCK_TYPES.has(block))
    .sort((a, b) => b[1] - a[1]);

  if (unclassifiedTypes.length === 0 && unclassifiedBlocks.length === 0 && functionCallIssues.length === 0) {
    console.log('  ✅ 本会话结构与项目读取基线完全匹配');
  }
  if (unclassifiedTypes.length > 0) {
    console.log('  🆕 项目未识别的新顶层 type:');
    for (const [type, n] of unclassifiedTypes) console.log(`    🆕 ${String(n).padStart(5)}  ${type}`);
  }
  if (unclassifiedBlocks.length > 0) {
    console.log('  🆕 项目未识别的新 content block 类型:');
    for (const [block, n] of unclassifiedBlocks) console.log(`    🆕 ${String(n).padStart(5)}  ${block}`);
  }
  if (functionCallIssues.length > 0) {
    console.log('  ⚠️ 事件字段或 system subtype 变化:');
    for (const issue of functionCallIssues.slice(0, 8)) console.log(`    ⚠️  ${issue}`);
  }

  console.log('\n[下一步]');
  console.log('  1. 顶层 type 若出现 🆕：确认它是否被 normalizeMessage / readTranscript 处理。');
  console.log('  2. content block 出现新类型（input_text/output_text/reasoning_text/tool_use/tool_result 之外）需评估是否要渲染。');
  console.log('  3. 用户输入提取 ⚠️：<user_query> 标签结构变化会让历史显示注入上下文，需改 extractUserPrompt。');
  console.log('  4. 完整基线见 SKILL.md「格式基线」章节。\n');
}

const args = process.argv.slice(2);
const allFlag = args.includes('--all');
const explicitPath = args.find((a) => !a.startsWith('--') && a.endsWith('.jsonl'));

(async () => {
  let files = [];
  if (explicitPath) {
    files = [path.resolve(explicitPath)];
  } else {
    files = findSessionFiles(allFlag ? 5 : 1);
  }

  if (files.length === 0) {
    console.log('未找到任何 WorkBuddy transcript 会话文件。');
    console.log('请先使用 WorkBuddy / CodeBuddy 进行一个会话，或指定路径：');
    console.log('  node check-workbuddy-format.mjs <transcript.jsonl>');
    process.exit(1);
  }

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`文件不存在: ${file}`);
      continue;
    }
    const data = await analyzeSession(file);
    printReport(file, data);
  }
})();
