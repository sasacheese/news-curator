import { useEffect, useState } from 'react';
import { loadTopicsConfig } from '../api';
import { CopyButton, LoadingCards, Notice, TagInput } from '../components';
import { safeUrl } from '../format';
import {
  type Theme,
  clearLocalTopics,
  getLocalTopics,
  getRepo,
  getTheme,
  getToken,
  pushTopicsToGitHub,
  saveLocalTopics,
  setRepo as persistRepo,
  setTheme as persistTheme,
  setToken as persistToken,
} from '../settings';
import type { Topic, TopicsConfig } from '../types';

type Status = { kind: 'ok' | 'error' | 'info'; message: string; url?: string } | null;

const EMPTY_TOPIC: Topic = { name: '', weight: 3, keywords: [] };

export function SettingsView() {
  const [remote, setRemote] = useState<TopicsConfig | null>(null);
  const [config, setConfig] = useState<TopicsConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [pushing, setPushing] = useState(false);

  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [repo, setRepoState] = useState(() => getRepo());
  const [token, setTokenState] = useState(() => getToken());

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

  const push = async () => {
    setPushing(true);
    setStatus(null);
    try {
      persistRepo(repo);
      persistToken(token);
      const url = await pushTopicsToGitHub(config, { repo, token });
      clearLocalTopics();
      setDirty(false);
      setRemote(config);
      setStatus({
        kind: 'ok',
        message: 'config/topics.json をコミットしました。次回の実行から反映されます。',
        url,
      });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPushing(false);
    }
  };

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">設定</h1>
      </div>

      {status && (
        <div style={{ marginBottom: 18 }}>
          <Notice kind={status.kind === 'ok' ? 'ok' : status.kind === 'error' ? 'error' : 'info'}>
            {status.message}
            {status.url && (
              <>
                {' '}
                <a href={safeUrl(status.url)} target="_blank" rel="noreferrer noopener">
                  コミットを見る ↗
                </a>
              </>
            )}
          </Notice>
        </div>
      )}

      {dirty && (
        <div style={{ marginBottom: 18 }}>
          <Notice>
            未保存の変更があります（このブラウザにのみ保存されています）。
            収集処理に反映するには、下の「GitHub に保存」でリポジトリへコミットしてください。
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

      {/* ---------------- 保存 ---------------- */}
      <section className="settings-section">
        <h2>変更をリポジトリに保存</h2>
        <p>
          収集処理は GitHub Actions 上で <code>config/topics.json</code> を読むため、
          設定を反映するにはリポジトリへコミットする必要があります。
          トークンはこのブラウザの localStorage にのみ保存され、送信先は api.github.com だけです。
          <br />
          Fine-grained personal access token を、このリポジトリに対して{' '}
          <strong>Contents: Read and write</strong> の権限で発行してください。
        </p>

        <div className="field">
          <label className="field__label" htmlFor="repo">
            リポジトリ
          </label>
          <input
            id="repo"
            type="text"
            value={repo}
            placeholder="owner/repo"
            onChange={(e) => setRepoState(e.target.value)}
            onBlur={(e) => persistRepo(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="token">
            GitHub トークン
          </label>
          <input
            id="token"
            type="password"
            value={token}
            placeholder="github_pat_..."
            autoComplete="off"
            onChange={(e) => setTokenState(e.target.value)}
            onBlur={(e) => persistToken(e.target.value)}
          />
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={pushing || !repo || !token}
            onClick={push}
          >
            {pushing ? '保存中…' : 'GitHub に保存'}
          </button>
          <CopyButton text={serialized} label="JSON をコピー" />
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

        <p className="field__hint" style={{ marginTop: 12 }}>
          トークンを使いたくない場合は「JSON をコピー」して、リポジトリの{' '}
          <code>config/topics.json</code> に直接貼り付けてください。
        </p>
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
