import { useState } from 'react';
import type { TrialReport, TrialVerdict } from './types';

/**
 * サンドボックスで試した結果。
 *
 * **依頼するボタンは自分にしか見えないが、結果は誰にでも見せる。** 試した結果から
 * しか分からないことは、この画面でいちばん価値のある中身なので、隠す理由が無い。
 *
 * 並べる順に意味を持たせている。最初に判定と 1 行の結論、次に「問い → 答え」。
 * 打ったコマンドは畳んである——コマンド列は証跡としては要るが、読者が最初に
 * 読みたいものではない（読みたいのは、記事を読んでも分からなかったことの答え）。
 */

const VERDICT: Record<TrialVerdict, { label: string; mark: string }> = {
  worked: { label: '動いた', mark: '✓' },
  partly: { label: '一部だけ動いた', mark: '△' },
  failed: { label: '動かせなかった', mark: '×' },
};

export function TrialReportView({
  report,
  compact = false,
}: {
  report: TrialReport;
  /** 一覧の行の中に出すとき。1 行の結論だけ見せて、残りは畳む */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const v = VERDICT[report.verdict];

  if (compact && !expanded) {
    return (
      <button
        type="button"
        className={`trial-line trial-line--${report.verdict}`}
        onClick={() => setExpanded(true)}
        title="試した結果を開く"
      >
        <span className="trial-line__mark">{v.mark}</span>
        <span className="trial-line__text">{report.headline}</span>
        {/*
          * 中身の量を出す。「試した結果」だけだと 1 行の結論で終わりに見えて、
          * その裏に千字ぶんの答えと手順があることが伝わらない（実測でそう見えた）。
          */}
        <span className="trial-line__more">{summarize(report)} ▾</span>
      </button>
    );
  }

  return (
    <div className={`trial trial--report trial--${report.verdict}`}>
      <p className="trial__lead">
        試した結果
        <span className="trial__verdict">
          {v.mark} {v.label}
        </span>
      </p>

      <p className="trial__headline">{report.headline}</p>

      {/* 何を聞いたかが見えないと、答えが妥当かを読者が判断できない */}
      {report.ask && (
        <p className="trial__ask-echo">
          <b>依頼:</b> {report.ask}
        </p>
      )}

      {report.answers.length > 0 && (
        <dl className="trial__answers">
          {report.answers.map((a, i) => (
            <div className="trial__answer" key={i}>
              <dt>{a.question}</dt>
              <dd>{a.answer}</dd>
            </div>
          ))}
        </dl>
      )}

      {/*
        * 掲載していた「試し方」との食い違い。この機能がいちばん効くのはここで、
        * 手順が古い・足りないことは実際に踏まないと分からない。
        */}
      {report.correction && (
        <p className="trial__correction">
          <b>掲載していた試し方との違い:</b> {report.correction}
        </p>
      )}

      {report.stumbles.length > 0 && (
        <ul className="trial__stumbles">
          {report.stumbles.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}

      {report.steps.length > 0 && (
        <>
          <button
            type="button"
            className="trial__toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? '打ったコマンドを畳む' : `打ったコマンド（${report.steps.length}）`}
          </button>
          {open && (
            <ol className="trial__steps">
              {report.steps.map((s, i) => (
                <li key={i} className={s.ok ? 'trial__step' : 'trial__step trial__step--ng'}>
                  <code>{s.command}</code>
                  <span className="trial__step-note">
                    {s.ok ? '✓' : '×'} {s.note}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {/*
        * 金額は公開価格からの概算で、採点役の消費は含まれないことがある。
        * 「いくらかかる機能なのか」を隠さないために出しているので、
        * 正確な請求額ではないことも内訳に書いてある。
        */}
      <p className="trial__note">
        {formatRanAt(report.ranAt)}に素の Linux コンテナで実行（{Math.round(report.seconds / 60)}{' '}
        分{report.cost ? ` ・ 概算 ${formatUsd(report.cost.estimatedUsd)}` : ''}）。
        人の手は入っていません。
        {report.cost && (
          <span className="trial__cost" title={costDetail(report.cost)}>
            {' '}
            費用の内訳
          </span>
        )}
      </p>
    </div>
  );
}

/** 折り畳んだ行に出す「中身の量」。押す価値があるかを一目で分かるようにする */
function summarize(report: TrialReport): string {
  const parts = [
    report.answers.length > 0 ? `答え${report.answers.length}` : '',
    report.steps.length > 0 ? `手順${report.steps.length}` : '',
    report.stumbles.length > 0 ? `詰まり${report.stumbles.length}` : '',
    report.correction ? '訂正あり' : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('・') : '試した結果';
}

function formatUsd(usd: number | null): string {
  return usd == null ? '不明' : `$${usd.toFixed(2)}`;
}

/** hover で出す内訳。画面を数字で埋めずに、必要なときだけ見えるようにする */
function costDetail(cost: NonNullable<TrialReport['cost']>): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return [
    `モデル: ${cost.model}`,
    `入力 ${k(cost.inputTokens)} / 出力 ${k(cost.outputTokens)}`,
    `キャッシュ 読み ${k(cost.cacheReadTokens)} / 書き ${k(cost.cacheWriteTokens)}`,
    '公開価格からの概算（採点役の消費は含まれないことがあります）',
  ].join('\n');
}

function formatRanAt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'いつか';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}
