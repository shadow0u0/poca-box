#!/usr/bin/env node
/**
 * Who may use the shared cloud space.
 *
 * `firebase/allowlist.json` is the only place the list is written. This script
 * copies it into the two places that actually enforce it:
 *
 *   - `firebase/firestore.rules`      → guards the card data
 *   - `worker/src/allowlist.generated.ts` → guards the photos
 *
 * Both are needed. Only updating the rules leaves the photo Worker open; only
 * updating the Worker leaves Firestore open. Keeping one source and generating
 * both is what stops them drifting apart, and `check` fails the build if
 * someone edits a generated file by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'firebase/allowlist.json');
const RULES = join(root, 'firebase/firestore.rules');
const WORKER = join(root, 'worker/src/allowlist.generated.ts');

const BEGIN = '// >>> generated from firebase/allowlist.json — do not edit by hand';
const END = '// <<< generated';

/**
 * Firebase uids are alphanumeric. `_` and `-` are tolerated because the test
 * harness signs tokens for made-up accounts; anything beyond that — an `@`, a
 * space, a slash — means an email or a URL was pasted in by mistake.
 */
const UID = /^[A-Za-z0-9_-]{6,128}$/;

function load() {
  const data = JSON.parse(readFileSync(SOURCE, 'utf8'));
  data.members ??= [];
  const members = data.members;
  const seen = new Set();
  for (const m of members) {
    if (!UID.test(m.uid ?? '')) throw new Error(`allowlist.json 有無效的 uid：${JSON.stringify(m.uid)}`);
    if (seen.has(m.uid)) throw new Error(`allowlist.json 有重複的 uid：${m.uid}`);
    seen.add(m.uid);
  }
  return { data, members };
}

function rulesBlock(members) {
  // An empty list must deny, not accidentally allow. `uid in []` would be
  // correct too, but spelling it out leaves no room to misread.
  const body =
    members.length === 0
      ? '      return false;'
      : [
          '      return request.auth != null && request.auth.uid in [',
          // No trailing comma on the last entry: the rules language is not
          // JavaScript and rejects it.
          members
            .map((m, i) => {
              const comma = i < members.length - 1 ? ',' : '';
              return `        '${m.uid}'${comma}${m.note ? ` // ${m.note}` : ''}`;
            })
            .join('\n'),
          '      ];',
        ].join('\n');

  return [
    `    ${BEGIN}`,
    '    // 名單是空的代表誰都不能用 —— 包含你自己。加人見 firebase/allowlist.json。',
    '    function invited() {',
    body,
    '    }',
    `    ${END}`,
  ].join('\n');
}

function workerFile(members) {
  const list = members.map((m) => `  '${m.uid}', // ${m.note ?? ''}`.trimEnd()).join('\n');
  return `${BEGIN.replace('// ', '/* ').concat(' */')}
/* eslint-disable */
// 執行 npm run allowlist:add <uid> "暱稱" 之後會重新產生。

export const ALLOWED_UIDS: ReadonlySet<string> = new Set([
${list}
]);
${END.replace('// ', '/* ').concat(' */')}
`;
}

function generate() {
  const { members } = load();

  const rules = readFileSync(RULES, 'utf8');
  const begin = rules.indexOf(BEGIN);
  const end = rules.indexOf(END);
  if (begin === -1 || end === -1) {
    throw new Error(`${RULES} 找不到產生區塊的標記，請確認 "${BEGIN}" 還在。`);
  }
  // Replace whole lines, so indentation is whatever this script writes rather
  // than whatever survived the last edit.
  const before = rules.slice(0, rules.lastIndexOf('\n', begin) + 1);
  const after = rules.slice(rules.indexOf('\n', end) + 1);
  const nextRules = `${before}${rulesBlock(members)}\n${after}`;

  return { members, files: [[RULES, nextRules], [WORKER, workerFile(members)]] };
}

const [command, uid, note] = process.argv.slice(2);

if (command === 'add' || command === 'remove') {
  if (!UID.test(uid ?? '')) {
    console.error(`用法：npm run allowlist:${command} -- <uid>${command === 'add' ? ' "暱稱"' : ''}`);
    console.error('uid 是英數字串，朋友登入後畫面上的「你的帳號代碼」就是它。');
    process.exit(1);
  }
  const { data, members } = load();
  if (command === 'add') {
    if (members.some((m) => m.uid === uid)) console.log(`已經在名單裡：${uid}`);
    else members.push({ uid, note: note ?? '' });
  } else {
    data.members = members.filter((m) => m.uid !== uid);
    if (data.members.length === members.length) console.log(`名單裡本來就沒有：${uid}`);
  }
  writeFileSync(SOURCE, `${JSON.stringify(data, null, 2)}\n`);
}

if (command === 'check') {
  const { files } = generate();
  const stale = files.filter(([path, next]) => readFileSync(path, 'utf8') !== next);
  if (stale.length > 0) {
    console.error('這些檔案與 firebase/allowlist.json 不一致：');
    for (const [path] of stale) console.error(`  ${path.replace(`${root}/`, '')}`);
    console.error('請執行 npm run allowlist:generate 之後重新提交。');
    process.exit(1);
  }
  console.log('白名單一致 ✓');
} else {
  const { members, files } = generate();
  for (const [path, next] of files) writeFileSync(path, next);
  console.log(`白名單 ${members.length} 人：`);
  for (const m of members) console.log(`  ${m.uid}  ${m.note ?? ''}`);
  if (members.length === 0) {
    console.log('\n⚠️  名單是空的 —— 部署之後所有人（包含你）都會被擋在外面。');
    console.log('   先把自己的 uid 加進去：npm run allowlist:add -- <uid> "你的暱稱"');
  }
  console.log('\n已更新 firebase/firestore.rules 與 worker/src/allowlist.generated.ts。');
  console.log('記得：commit 之後還要到 Firebase 主控台把規則重新「發布」一次。');
}
