import { useEffect, useState } from 'react';
import { loadTopicsConfig } from '../api';
import { CopyButton, LoadingCards, Notice, TagInput } from '../components';
import { editUrl, isRepoSlug } from '../github';
import {
  type Theme,
  clearLocalTopics,
  getLocalTopics,
  getTheme,
  saveLocalTopics,
  setTheme as persistTheme,
} from '../settings';
import type { Manifest, Topic, TopicsConfig } from '../types';

type Status = { kind: 'ok' | 'error' | 'info'; message: string } | null;

const EMPTY_TOPIC: Topic = { name: '', weight: 3, keywords: [] };
const TOPICS_PATH = 'config/topics.json';

export function SettingsView({ manifest }: { manifest: Manifest | null }) {
  const [remote, setRemote] = useState<TopicsConfig | null>(null);
  const [config, setConfig] = useState<TopicsConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const repo = isRepoSlug(manifest?.repo) ? manifest.repo : null;

  useEffect(() => {
    loadTopicsConfig().then(
      (fetched) => {
        setRemote(fetched);
        const local = getLocalTopics();
        setConfig(local ?? fetched);
        setDirty(local !== null);
      },
      (err: unknown) => {
        setStatus({
          kind: 'error',
          message: `config/topics.json を読み込めませんでした: ${err instanceof Error ? err.message : String(err)}`,
        });
        setConfig(getLocalTopics() ?? { profile: '', topics: [], exclude: { keywords: [] } });
      },
    );
  }, []);

  if (!config) return <LoadingCards count={2} />;

  const update = (next: TopicsConfig) => {
    setConfig(next);
    setDirty(true);
    saveLocalTopics(next);
    setStatus(null);
  };

  const updateTopic = (index: number, patch: Partial<Topic>) => {
    const topics = config.topics.map((t, i) => (i === index ? { ...t, ...patch } : t));
    update({ ...config, topics });
  };

  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">設定</h1>
      </div>

      {/*
        久しぶりに開いたときに一番忘れているのは「編集しただけでは何も起きない」こと。
        3 段階のどこにいるかが一目で分かる形にして、本文より前に置く。
      */}
      <section className="howto">
        <h2 className="howto__title">この画面で編集しても、すぐには反映されません</h2>
        <ol className="howto__steps">
          <li>
            <strong>編集する</strong>
            <span>
              内容は<strong>このブラウザの中だけ</strong>に一時保存されます（localStorage）。
              他の端末や他のブラウザからは見えず、毎朝の収集にもまだ影響しません。
            </span>
          </li>
          <li>
            <strong>GitHub にコミットする</strong>
            <span>
              下の「変更をリポジトリに反映する」の手順で <code>{TOPICS_PATH}</code> に
              コミットします。<strong>ここで初めて確定します。</strong>
            </span>
          </li>
          <li>
            <strong>翌朝の実行から効く</strong>
            <span>
              収集は毎朝 7:00 の GitHub Actions で走るので、反映されるのは次回の実行からです。
              今日のダイジェストが作り直されるわけではありません。
            </span>
          </li>
        </ol>
        <p className="howto__note">
          コミットしなければ何も変わりません。途中まで編集して閉じても大丈夫で、
          次に同じブラウザで開けば続きから編集できます。やり直したいときは
          「リポジトリの内容に戻す」で現在のリポジトリの内容に戻せます。
        </p>
      </section>

      {status && (
        <div style={{ marginBottom: 18 }}>
          <Notice kind={status.kind === 'ok' ? 'ok' : status.kind === 'error' ? 'error' : 'info'}>
            {status.message}
          </Notice>
        </div>
      )}

      {dirty && (
        <div style={{ marginBottom: 18 }}>
          <Notice>
            未保存の変更があります（このブラウザにのみ保存されています）。
            収集処理に反映するには、下の「変更をリポジトリに反映する」の手順でコミットしてください。
          </Notice>
        </div>
      )}

      {/* ---------------- 関心トピック ---------------- */}
      <section className="settings-section">
        <h2>関心トピック</h2>
        <p>
          毎朝の採点で使われます。重要度が高いトピックほど、その分野の記事が上位に来やすくなります。
          キーワードは事前フィルタ用で、記事タイトル・タグ・本文に対する部分一致で判定されます（小文字比較）。
        </p>

        <div className="topic-editor">
          <div className="topic-row topic-row__head">
            <div>トピック名</div>
            <div>重要度</div>
            <div>キーワード</div>
            <div />
          </div>

          {config.topics.map((topic, i) => (
            <div className="topic-row" key={i}>
              <input
                type="text"
                value={topic.name}
                placeholder="例: React"
                onChange={(e) => updateTopic(i, { name: e.target.value })}
                aria-label="トピック名"
              />
              <select
                value={topic.weight}
                onChange={(e) => updateTopic(i, { weight: Number(e.target.value) })}
                aria-label="重要度"
              >
                {[5, 4, 3, 2, 1].map((w) => (
                  <option key={w} value={w}>
                    {w} / 5
                  </option>
                ))}
              </select>
              <TagInput
                values={topic.keywords}
                onChange={(keywords) => updateTopic(i, { keywords })}
                placeholder="キーワードを入力して Enter"
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() =>
                  update({ ...config, topics: config.topics.filter((_, idx) => idx !== i) })
                }
                aria-label={`${topic.name || 'このトピック'} を削除`}
              >
                削除
              </button>
            </div>
          ))}
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => update({ ...config, topics: [...config.topics, { ...EMPTY_TOPIC }] })}
          >
            + トピックを追加
          </button>
        </div>
      </section>

      {/* ---------------- 読者プロフィール ---------------- */}
      <section className="settings-section">
        <h2>読者プロフィール</h2>
        <p>
          AI に渡される、あなた自身の説明です。使っている技術・立場・何に興味があって何に興味がないかを
          書くほど、採点と要約の精度が上がります。
        </p>
        <textarea
          rows={5}
          value={config.profile}
          onChange={(e) => update({ ...config, profile: e.target.value })}
          placeholder="例: React / Next.js / TypeScript を主戦場にしたフルスタックエンジニア。…"
        />
      </section>

      {/* ---------------- 除外キーワード ---------------- */}
      <section className="settings-section">
        <h2>除外キーワード</h2>
        <p>タイトルやタグにこれらを含む記事は大きく減点されます（求人・宣伝・ポエム対策）。</p>
        <TagInput
          values={config.exclude.keywords}
          onChange={(keywords) => update({ ...config, exclude: { keywords } })}
          placeholder="除外したい語を入力して Enter"
        />
      </section>

      {/* ---------------- 反映 ---------------- */}
      <section className="settings-section">
        <h2>変更をリポジトリに反映する</h2>
        <p>
          収集処理は GitHub Actions 上で <code>{TOPICS_PATH}</code> を読むため、
          この画面の編集内容は一度リポジトリへコミットする必要があります。
          コミットは GitHub の Web エディタで行うので、アクセストークンは要りません。
        </p>

        <ol className="steps">
          <li>
            <strong>JSON をコピー</strong> で、この画面の内容をクリップボードに取る
          </li>
          <li>
            <strong>GitHubで編集</strong> で <code>{TOPICS_PATH}</code> の編集画面を開く
          </li>
          <li>中身を貼り替えてコミットする（翌朝の実行から反映されます）</li>
        </ol>

        <div className="actions">
          <CopyButton text={serialized} label="JSON をコピー" />
          {repo && (
            <a
              className="btn btn--primary"
              href={editUrl(repo, TOPICS_PATH)}
              target="_blank"
              rel="noreferrer noopener"
            >
              GitHubで編集 ↗
            </a>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!remote}
            onClick={() => {
              if (!remote) return;
              clearLocalTopics();
              setConfig(remote);
              setDirty(false);
              setStatus({ kind: 'info', message: 'リポジトリの内容に戻しました。' });
            }}
          >
            リポジトリの内容に戻す
          </button>
        </div>

        {!repo && (
          <p className="field__hint" style={{ marginTop: 12 }}>
            リポジトリが特定できないため編集リンクを出せません。コピーした JSON を{' '}
            <code>{TOPICS_PATH}</code> に直接貼り付けてください。
          </p>
        )}
      </section>

      {/* ---------------- 表示 ---------------- */}
      <section className="settings-section">
        <h2>表示</h2>
        <p>テーマの設定はこのブラウザにのみ保存されます。</p>
        <div className="segmented">
          {(['auto', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={theme === t}
              onClick={() => {
                setThemeState(t);
                persistTheme(t);
              }}
            >
              {t === 'auto' ? 'OS に従う' : t === 'light' ? 'ライト' : 'ダーク'}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
