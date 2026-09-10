#!/usr/bin/env node
/**
 * Pi transcript 格式兼容性检查器
 *
 * 解析 getPiSessionsRoot() 下最新的 Pi transcript JSONL
 * （~/.pi/agent/sessions/<encoded-cwd>/<ISO时间戳>_<uuid>.jsonl），对照 cloudcli 的
 * 读取基线（pi-sessions.provider.ts 的 normalizePiAgentMessage / readTranscript、
 * 同步器 processSessionFile、runtime 的 processLine），找出可能因 Pi 引擎升级而变化的
 * 结构（新顶层 type / 新 message role / 新 content block / parentId 树回溯断裂 /
 * compaction 语义变化 / header 字段变化等）。
 *
 * 用法：
 *   node check-pi-format.mjs                  # 自动找最新会话
 *   node check-pi-format.mjs <jsonl路径>       # 检查指定会话
 *   node check-pi-format.mjs --all            # 最近 5 个会话
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/**
 * 会话根目录，按官方 settings.md 的优先级：
 *   --session-dir（CLI 运行时 flag，脚本无法探知，忽略）>
 *   PI_CODING_AGENT_SESSION_DIR >
 *   sessionDir（settings.json）>
 *   <PI_CODING_AGENT_DIR>/sessions（PI_CODING_AGENT_DIR 默认 ~/.pi/agent）。
 * 注意项目 getPiSessionsRoot() 目前只覆盖 env 两级、未读 sessionDir —— 本脚本补上
 * sessionDir，保证用户用它自定义存放时仍能发现会话（provider 代码路线待复核）。
 */
function sessionRoot() {
  const override = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (override) {
    return override;
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    || path.join(os.homedir(), '.pi', 'agent');

  // settings.json 的 sessionDir：官方允许相对路径（相对 agentDir）、绝对路径、`~`。
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    const sessionDir = typeof settings?.sessionDir === 'string'
      ? settings.sessionDir.trim()
      : '';
    if (sessionDir) {
      const expanded = sessionDir.startsWith('~')
        ? path.join(os.homedir(), sessionDir.slice(1))
        : sessionDir;
      return path.isAbsolute(expanded) ? expanded : path.resolve(agentDir, expanded);
    }
  } catch {
    // 无 settings.json 或 sessionDir 未配置 —— 走默认。
  }

  return path.join(agentDir, 'sessions');
}

/**
 * 项目读取并渲染消息的顶层 type（readTranscript 的 processEntry + compaction 分支）。
 */
const KNOWN_RENDER_TYPES = new Set(['message', 'branch_summary', 'compaction']);

/**
 * 项目读取但不渲染聊天消息的顶层 type（同步器 / 定位消费）。
 */
const KNOWN_METADATA_TYPES = new Map([
  ['session', 'header（id/cwd/version，同步器索引 + fetchHistory 定位）'],
  ['session_info', '会话名来源（同步器读顶层 name）'],
]);

/**
 * 已评估无影响：readTranscript 跳过，不展示。
 */
const KNOWN_NOT_READ_TYPES = new Map([
  ['model_change', '模型切换记录，跳过'],
  ['thinking_level_change', '思考等级切换记录，跳过'],
  ['label', '标签记录，跳过'],
  ['custom', '自定义条目，历史读取跳过（仅裸 AgentMessage role=custom 由 normalizePiAgentMessage 渲染）'],
  ['custom_message', '自定义消息，历史读取跳过'],
]);

/**
 * message.role（AgentMessage.role）分类：normalizePiAgentMessage 认知。
 * 未知 role 会落入 assistant 分支兜底（可能误渲染），属于升级信号。
 */
const KNOWN_MESSAGE_ROLES = new Map([
  ['user', '文本/图片内容'],
  ['assistant', 'thinking/text/toolCall 块 + usage/stopReason'],
  ['toolResult', '工具结果，按 toolCallId 配对'],
  ['custom', 'display 文本（历史主路径通常不出现）'],
  ['compactionSummary', 'normalizePiAgentMessage 内部角色（summary）'],
  ['branchSummary', 'normalizePiAgentMessage 内部角色（summary）'],
]);

/**
 * 官方 AgentMessage union 的 builtin role，但项目未适配渲染（与 Claude/Codex 对 `!`
 * 命令结果不单独成行的一致取向：不渲染，故不进 KNOWN_MESSAGE_ROLES）。
 * bashExecution 是 `!`/`!!` 命令产物，字段为 command/output/exitCode/cancelled/truncated，
 * 无 content —— 落入 assistant 兜底时因 content 非数组且为空而返回空数组（静默丢弃）。
 */
const KNOWN_BUILTIN_UNSUPPORTED_ROLES = new Map([
  ['bashExecution', '官方 builtin role（! 命令产物），项目不渲染（已知，非升级信号）'],
]);

/**
 * message.content 数组元素类型（normalizePiAgentMessage 认知）。
 */
const KNOWN_BLOCK_TYPES = new Set(['text', 'thinking', 'toolCall', 'image']);

async function analyzeSession(filePath) {
  const typeCounts = new Map();
  const roleCounts = new Map();
  const blockTypes = new Map();
  const badLines = { total: 0, skipped: 0 };
  const headerIssues = [];
  const compactionIssues = [];
  const messageIssues = [];

  let header = null;
  // 非 header 的 entry（供 parentId 树回溯检查），按文件顺序保留。
  const entries = [];

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

    // 首行 session header：同步器/定位的关键，只记录第一条。
    if (type === 'session' && header === null) {
      header = entry;
      if (typeof entry.id !== 'string' || !entry.id.trim()) {
        headerIssues.push('header 缺 id（UUID）—— 同步器无法索引，fetchHistory 无法定位');
      }
      if (typeof entry.cwd !== 'string' || !entry.cwd.trim()) {
        headerIssues.push('header 缺 cwd —— project_path 丢失，解析定位走 UUID 递归兜底');
      }
      const version = typeof entry.version === 'number' ? entry.version : undefined;
      if (version !== undefined && version < 3) {
        headerIssues.push(`header version=${version}：${version === 1 ? 'v1 线性旧格式（无 parentId 树，回溯不适用，属历史格式）' : 'v2 树结构但 role 用 hookMessage（v3 才改名 custom）'} —— 确认读取逻辑兼容`);
      } else if (version !== undefined && version > 3) {
        headerIssues.push(`header version=${version}（基线为 3 的未来值）—— 确认读取逻辑是否仍兼容`);
      }
      continue;
    }

    entries.push({ id: entry.id, parentId: entry.parentId });

    if (type === 'message') {
      const message = entry.message;
      if (!message || typeof message !== 'object') {
        messageIssues.push(`message entry（id=${entry.id ?? '?'}）缺 message 子对象 —— normalize 返回空`);
        continue;
      }
      const role = message.role;
      if (role) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      if (!KNOWN_MESSAGE_ROLES.has(role) && !KNOWN_BUILTIN_UNSUPPORTED_ROLES.has(role)) {
        messageIssues.push(`未知 message.role「${role}」（id=${entry.id ?? '?'}）—— 会落入 assistant 分支兜底，可能误渲染`);
      }
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block.type === 'string') {
            blockTypes.set(block.type, (blockTypes.get(block.type) ?? 0) + 1);
          }
        }
      }
    }

    if (type === 'compaction') {
      const summary = typeof entry.summary === 'string' && entry.summary.trim();
      const firstKept = typeof entry.firstKeptEntryId === 'string' && entry.firstKeptEntryId.trim();
      const retainedTail = Array.isArray(entry.retainedTail);
      // retainedTail 是 readTranscript 已支持的防御分支（0.85.1 主路径为 firstKeptEntryId），
      // 不作为断裂信号；三者全无时 compaction 才会完全失效。
      if (!summary && !firstKept && !retainedTail) {
        compactionIssues.push('compaction 缺 summary / firstKeptEntryId / retainedTail —— 保留窗口无法生效（summary 不渲染、旧条目不裁剪）');
      }
    }
  }

  const tree = checkTree(entries);
  return {
    typeCounts, roleCounts, blockTypes, badLines, headerIssues,
    compactionIssues, messageIssues, tree, header,
  };
}

/**
 * 模拟 readTranscript 的「从最后一条 entry 沿 parentId 回溯到根」：
 * 发现叶子缺失、断链、缺 id/parentId 等会让 active path 静默截断的信号。
 */
function checkTree(entries) {
  const issues = [];
  const byId = new Map();
  for (const entry of entries) {
    if (typeof entry.id === 'string') {
      byId.set(entry.id, entry);
    }
  }

  if (entries.length === 0) {
    return { issues, visited: 0, total: 0, orphan: 0 };
  }

  const leaf = entries[entries.length - 1];
  if (typeof leaf.id !== 'string') {
    issues.push('最后一条 entry 缺 id（叶子）—— readTranscript 无法回溯，active path 只剩该叶');
    return { issues, visited: 1, total: entries.length, orphan: entries.length - 1 };
  }

  const seen = new Set();
  let cursor = leaf.id;
  let visited = 0;
  while (typeof cursor === 'string' && !seen.has(cursor)) {
    const entry = byId.get(cursor);
    if (!entry) {
      issues.push(`parentId 断链：id「${cursor}」在文件中不存在 —— 回溯在此提前终止，更早的消息会丢失`);
      break;
    }
    seen.add(cursor);
    visited += 1;
    if (entry.parentId == null) break; // 到达根
    if (!byId.has(entry.parentId)) {
      issues.push(`parentId 断链：entry「${entry.id}」的 parentId「${entry.parentId}」指向不存在的 id —— 回溯提前终止`);
      break;
    }
    cursor = entry.parentId;
  }

  const orphan = entries.filter((entry) => typeof entry.id === 'string' && !seen.has(entry.id)).length;
  const idMissing = entries.filter((entry) => typeof entry.id !== 'string').length;
  const nonRootParentMissing = entries.filter((entry, index) => index > 0 && entry.parentId == null).length;

  if (idMissing > 0) {
    issues.push(`${idMissing} 条 entry 缺 id —— 无法进入 byId 索引，回溯会跳过它们`);
  }
  if (nonRootParentMissing > 0) {
    issues.push(`${nonRootParentMissing} 条非根 entry 缺 parentId（回溯会在其提前 break，可能是多处断链）`);
  }

  return { issues, visited, total: entries.length, orphan };
}

function findSessionFiles(limit) {
  const root = sessionRoot();
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  };
  walk(root);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.slice(0, limit);
}

/**
 * 从文件名 `<ISO时间戳>_<session-id>.jsonl` 提取 session-id，与 header id 比对。
 * 官方允许自定义 id（SDK / --session-id），所以 session-id 不一定是 UUID；
 * 返回 { id, isUuid }，非 UUID 时提示（旧逻辑用 36 位 UUID 正则会静默失配）。
 */
function filenameId(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/_([^_]+)\.jsonl$/);
  if (!match) {
    return { id: undefined, isUuid: false };
  }
  const id = match[1];
  return { id, isUuid: /^[0-9a-fA-F-]{36}$/.test(id) };
}

function printReport(filePath, data) {
  const {
    typeCounts, roleCounts, blockTypes, badLines, headerIssues,
    compactionIssues, messageIssues, tree, header,
  } = data;
  const root = sessionRoot();
  const rel = path.relative(root, filePath).startsWith('..')
    ? filePath
    : path.relative(root, filePath);

  console.log('\n=== Pi transcript 格式兼容性检查 ===\n');
  console.log(`检查文件: ${rel}`);
  console.log(`文件修改时间: ${fs.statSync(filePath).mtime.toISOString()}，共 ${badLines.total} 行`);

  if (badLines.total === 0) {
    console.log('  ⚠️ 空文件（0 行）：Pi 会为「开始过但未写入」的会话留空 transcript，');
    console.log('    fetchHistory 返回空历史。无内容可检查，跳过后续对照。\n');
    return;
  }
  if (badLines.skipped > 0) {
    console.log(`  ℹ️ 坏行 ${badLines.skipped} 条已跳过（与 readTranscript 的 JSON.parse 容错一致）`);
  }

  // header 一致性：文件名 session-id vs header id。
  if (header) {
    const fname = filenameId(filePath);
    if (typeof header.id === 'string' && fname.id && fname.id !== header.id) {
      headerIssues.push(`文件名 session-id（${fname.id}）≠ header id（${header.id}）—— provider_session_id 与 resolvePiTranscriptPath 的 suffix 匹配会错位`);
    } else if (typeof header.id === 'string' && fname.id === header.id && !fname.isUuid) {
      console.log(`  ℹ️ header id（${header.id}）非 UUID —— 由 SDK / --session-id 自定义；suffix 匹配（_<id>.jsonl）仍可用`);
    }
    if (typeof header.parentSession === 'string' && header.parentSession.trim()) {
      console.log(`  ℹ️ header 含 parentSession（${header.parentSession.trim()}）—— fork/clone/newSession 来源，同步器当前不索引`);
    }
  } else {
    headerIssues.push('未找到首行 session header —— 同步器不索引，session 不会出现在侧栏');
  }

  console.log('\n[顶层 type]');
  for (const [type, n] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const tag = KNOWN_RENDER_TYPES.has(type)
      ? '项目会渲染'
      : KNOWN_METADATA_TYPES.has(type)
        ? `已读(${KNOWN_METADATA_TYPES.get(type)})`
        : KNOWN_NOT_READ_TYPES.has(type)
          ? `已评估(${KNOWN_NOT_READ_TYPES.get(type)})`
          : '需评估';
    console.log(`  ${String(n).padStart(5)}  ${type}  — ${tag}`);
  }

  console.log('\n[message.role 分类]');
  if (roleCounts.size === 0) {
    console.log('  无 message 事件');
  }
  for (const [role, n] of [...roleCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const tag = KNOWN_MESSAGE_ROLES.has(role)
      ? `项目已适配(${KNOWN_MESSAGE_ROLES.get(role)})`
      : KNOWN_BUILTIN_UNSUPPORTED_ROLES.has(role)
        ? `官方存在但未渲染(${KNOWN_BUILTIN_UNSUPPORTED_ROLES.get(role)})`
        : '需评估';
    console.log(`  ${String(n).padStart(5)}  ${role}  — ${tag}`);
  }

  console.log('\n[content block 类型]');
  if (blockTypes.size === 0) {
    console.log('  无 content block（message 无 content 数组或内容为 string）');
  }
  for (const [block, n] of [...blockTypes.entries()].sort((a, b) => b[1] - a[1])) {
    const tag = KNOWN_BLOCK_TYPES.has(block) ? '项目已适配' : '需评估';
    console.log(`  ${String(n).padStart(5)}  ${block}  — ${tag}`);
  }

  console.log('\n[树形 parentId 回溯]');
  if (tree.total === 0) {
    console.log('  无 message/compaction 等 entry（仅 header），无可回溯内容');
  } else {
    console.log(`  最后一条 entry 沿 parentId 回溯到 ${tree.visited}/${tree.total} 条 entry（visited 即 active path 长度）`);
    if (tree.orphan > 0) {
      console.log(`  ℹ️ ${tree.orphan} 条 entry 不在 active path：可能是 Pi 的弃分支（edit/fork 后残留），读取时天然跳过`);
    }
  }

  console.log('\n[与项目读取逻辑对照]');
  const unclassifiedTypes = [...typeCounts.entries()]
    .filter(([type]) => !KNOWN_RENDER_TYPES.has(type)
      && !KNOWN_METADATA_TYPES.has(type)
      && !KNOWN_NOT_READ_TYPES.has(type))
    .sort((a, b) => b[1] - a[1]);
  const unclassifiedBlocks = [...blockTypes.entries()]
    .filter(([block]) => !KNOWN_BLOCK_TYPES.has(block))
    .sort((a, b) => b[1] - a[1]);

  const allIssues = [...headerIssues, ...tree.issues, ...compactionIssues, ...messageIssues];
  if (unclassifiedTypes.length === 0 && unclassifiedBlocks.length === 0 && allIssues.length === 0) {
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
  if (allIssues.length > 0) {
    console.log('  ⚠️ 字段 / 结构变化:');
    for (const issue of allIssues.slice(0, 10)) console.log(`    ⚠️  ${issue}`);
  }

  console.log('\n[下一步]');
  console.log('  1. 顶层 type 若出现 🆕：确认它是否被 readTranscript / normalizePiAgentMessage 处理。');
  console.log('  2. message.role 出现 user/assistant/toolResult/custom 之外：确认是否会被 assistant 分支兜底误渲染。');
  console.log('  3. content block 出现 text/thinking/toolCall/image 之外需评估是否要渲染。');
  console.log('  4. 树形 parentId 回溯 ⚠️：断链 / 缺 id 会让 readTranscript 静默丢失更早的消息（Pi 最关键信号）。');
  console.log('  5. header 字段 ⚠️：id/cwd/version 变了会影响同步器索引与 fetchHistory 定位。');
  console.log('  6. 完整基线见 SKILL.md「格式基线」章节。\n');
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
    console.log('未找到任何 Pi transcript 会话文件。');
    console.log(`查找根: ${sessionRoot()}`);
    console.log('请先使用 Pi CLI 进行一个会话，或指定路径：');
    console.log('  node check-pi-format.mjs <transcript.jsonl>');
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