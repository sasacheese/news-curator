import { readFile } from 'node:fs/promises';
import type { Digest, RankedItem } from './types.js';

/**
 * 2 つのダイジェストを並べて比べる。モデルを変えたときの差分を見るためのもの。
 *
 * 同じ入力（COLLECT_CACHE）で走らせた 2 本を渡すこと。
 * 収集からやり直したものどうしを比べると、モデルの差なのか
 * 母集団の差なのか分からなくなる。
 *
 *   npm run compare -- a.json b.json
 */

function pct(a: number, b: number): string {
  if (a === 0) return '—';
  const d = ((b - a) / a) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function costTable(a: Digest, b: Digest): void {
  const stages = [...new Set([...Object.keys(a.usage.stages), ...Object.keys(b.usage.stages)])];
  console.log('\n段階別');
  console.log(
    `  ${'段階'.padEnd(10)} ${'A 費用'.padStart(9)} ${'B 費用'.padStart(9)} ${'差'.padStart(6)}  ${'A 時間'.padStart(7)} ${'B 時間'.padStart(7)}`,
  );
  for (const stage of stages) {
    const sa = a.usage.stages[stage];
    const sb = b.usage.stages[stage];
    const ca = sa?.estimatedCostUsd ?? 0;
    const cb = sb?.estimatedCostUsd ?? 0;
    const ta = (sa?.elapsedMs ?? 0) / 1000;
    const tb = (sb?.elapsedMs ?? 0) / 1000;
    console.log(
      `  ${stage.padEnd(10)} ${usd(ca).padStart(9)} ${usd(cb).padStart(9)} ${pct(ca, cb).padStart(6)}  ` +
        `${`${ta.toFixed(1)}s`.padStart(7)} ${`${tb.toFixed(1)}s`.padStart(7)}` +
        `   ${sa?.model ?? '—'} → ${sb?.model ?? '—'}`,
    );
  }
  const ta = a.usage.totalCostUsd;
  const tb = b.usage.totalCostUsd;
  console.log(`  ${'合計'.padEnd(10)} ${usd(ta).padStart(9)} ${usd(tb).padStart(9)} ${pct(ta, tb).padStart(6)}`);
  console.log(`  月換算     ${usd(ta * 30).padStart(9)} ${usd(tb * 30).padStart(9)}`);
}

/** 同じ記事に対する判定がどれだけ一致したか。モデルの「性能」を機械的に見る側面 */
function agreement(a: Digest, b: Digest): void {
  const byId = new Map<string, RankedItem>();
  for (const i of [...a.top, ...a.others]) byId.set(i.id, i);

  const pairs = [...b.top, ...b.others]
    .map((i) => ({ a: byId.get(i.id), b: i }))
    .filter((p): p is { a: RankedItem; b: RankedItem } => p.a != null);

  if (pairs.length === 0) {
    console.log('\n両方に出てきた記事がありません（入力が違う可能性があります）');
    return;
  }

  const same = (f: (i: RankedItem) => unknown) =>
    pairs.filter((p) => f(p.a) === f(p.b)).length;
  const scoreDiff = pairs.map((p) => Math.abs(p.a.score - p.b.score));
  const avg = scoreDiff.reduce((s, n) => s + n, 0) / scoreDiff.length;

  console.log(`\n判定の一致（両方に出た ${pairs.length} 件）`);
  console.log(`  category   ${same((i) => i.category)}/${pairs.length}`);
  console.log(`  domain     ${same((i) => i.domain)}/${pairs.length}`);
  console.log(`  payoff     ${same((i) => i.payoff)}/${pairs.length}`);
  console.log(`  durability ${same((i) => i.durability)}/${pairs.length}`);
  console.log(`  スコア差   平均 ${avg.toFixed(1)} 点 / 最大 ${Math.max(...scoreDiff)} 点`);
}

/** 選ばれた記事そのものの違い。中身の質は最終的に目で見るしかない */
function selection(a: Digest, b: Digest): void {
  const ids = (d: Digest) => new Set(d.top.map((t) => t.id));
  const [ia, ib] = [ids(a), ids(b)];
  const onlyA = a.top.filter((t) => !ib.has(t.id));
  const onlyB = b.top.filter((t) => !ia.has(t.id));

  console.log(`\nベストN の一致: ${a.top.filter((t) => ib.has(t.id)).length}/${a.top.length} 件`);
  for (const t of onlyA) console.log(`  A のみ: ${t.title.slice(0, 56)}`);
  for (const t of onlyB) console.log(`  B のみ: ${t.title.slice(0, 56)}`);

  console.log('\n読みどころの見比べ（両方に出た先頭 3 件）');
  const byId = new Map(a.others.concat(a.top).map((i) => [i.id, i]));
  let shown = 0;
  for (const i of [...b.top, ...b.others]) {
    const counterpart = byId.get(i.id);
    if (!counterpart || shown >= 3) continue;
    shown++;
    console.log(`\n  ${i.title.slice(0, 60)}`);
    console.log(`    A: ${counterpart.reason || '(空)'}`);
    console.log(`    B: ${i.reason || '(空)'}`);
  }
}

async function main(): Promise<void> {
  const [pathA, pathB] = process.argv.slice(2);
  if (!pathA || !pathB) {
    console.error('使い方: npm run compare -- <A.json> <B.json>');
    process.exit(1);
  }
  const [a, b] = (await Promise.all([
    readFile(pathA, 'utf8').then(JSON.parse),
    readFile(pathB, 'utf8').then(JSON.parse),
  ])) as [Digest, Digest];

  console.log(`A: ${pathA}  (${a.models.rank} / ${a.models.summary})`);
  console.log(`B: ${pathB}  (${b.models.rank} / ${b.models.summary})`);
  if (a.stats.collected !== b.stats.collected) {
    console.log(
      `\n⚠ 入力が違います（収集 ${a.stats.collected} 件 vs ${b.stats.collected} 件）。` +
        'COLLECT_CACHE を指定して同じ入力で走らせてください。',
    );
  }

  for (const [label, d] of [['A', a], ['B', b]] as const) {
    if (d.usage.totalCostUsd === 0) {
      console.log(
        `\n⚠ ${label} の費用が $0 です。LLM_BACKEND=claude-code（従量課金なし）で走らせた可能性があります。` +
          '費用を比べるなら両方とも API キー経由で実行してください。',
      );
    }
    if (Object.values(d.usage.stages).every((s) => s.elapsedMs === 0)) {
      console.log(`⚠ ${label} に実行時間の記録がありません（この機能より前に生成されたもの）。`);
    }
  }

  costTable(a, b);
  agreement(a, b);
  selection(a, b);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
