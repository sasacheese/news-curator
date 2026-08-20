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

export function TrialReportView({ report }: { report: TrialReport }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[report.verdict];

  return (
    <div className={`trial trial--report trial--${report.verdict}`}>
      <p className="trial__lead">
        試した結果
        <span className="trial__verdict">
          {v.mark} {v.label}
        </span>
      </p>

      <p className="trial__headline">{report.headline}</p>

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

      <p className="trial__note">
        {formatRanAt(report.ranAt)}に素の Linux コンテナで実行（{Math.round(report.seconds / 60)}{' '}
        分）。人の手は入っていません。
      </p>
    </div>
  );
}

function formatRanAt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'いつか';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}
