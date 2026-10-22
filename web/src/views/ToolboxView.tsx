import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { loadToolArchive, loadToolBoard } from '../api';
import { Empty, LoadingCards, Notice } from '../components';
import { isFeedbackUnlocked } from '../settings';
import {
  KIND_LABELS,
  KIND_ORDER,
  PASS_REASON_LABELS,
  effectiveState,
  isToolboxWritable,
  normalizeSubmittedUrl,
  setToolState,
  sourceLabel,
  submitToolUrl,
} from '../toolbox';
import { TryBlock } from '../TryBlock';
import type { PassReason, ToolArchiveItem, ToolBoard, ToolBoardItem, ToolKind, ToolState } from '../types';

/**
 * 道具箱。記事ではなく道具を単位に、スマホで眺めて「気になる」を付け、
 * PC を触れるときにキューの先頭から試す、という使い方をする。
 *
 * 選別より網羅。量を抑えるのは collector 側の仕組み（新着のまま 7 日で退避・
 * 新しい信号で再浮上・見送り理由の学習）で、画面では種類の棚と検索で絞る。
 * 操作ボタンと「URL を貼って追加」は、フィードバックを解除した本人の端末だけに出す。
 */
export function ToolboxView() {
  const [board, setBoard] = useState<ToolBoard | null>(null);
  const [missing, setMissing] = useState(false);
  const [kind, setKind] = useState<ToolKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [archive, setArchive] = useState<ToolArchiveItem[] | null>(null);
  // 押した直後に棚を動かすため、状態は端末側の覚え書きと合わせて持つ
  const [states, setStates] = useState<Record<string, ToolState>>({});
  const [owner] = useState(isFeedbackUnlocked);
  const [writable, setWritable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadToolBoard().then(
      (b) => !cancelled && setBoard(b),
      // まだ一度も生成していないリポジトリでは 404 になる。エラー扱いにしない
      () => !cancelled && setMissing(true),
    );
    if (owner) isToolboxWritable().then((w) => !cancelled && setWritable(w));
    return () => {
      cancelled = true;
    };
  }, [owner]);

  // 検索したときだけ、退避・見送りしたものも読む
  useEffect(() => {
    if (!query.trim() || archive) return;
    loadToolArchive().then(setArchive, () => setArchive([]));
  }, [query, archive]);

  const stateOf = (item: ToolBoardItem): ToolState =>
    states[item.id] ?? (board ? effectiveState(item.id, item.state, board.date) : item.state);

  const change = (item: ToolBoardItem, state: ToolState, reason?: PassReason) => {
    setStates((s) => ({ ...s, [item.id]: state }));
    void setToolState(item.id, state, reason);
  };

  const all = useMemo(
    () => (board ? [...board.queue, ...board.items, ...board.tried] : []),
    [board],
  );

  if (missing) {
    return (
      <Empty title="まだ道具箱がありません">
        <p>Daily digest ワークフローを実行すると作られます。翌朝から道具が並び始めます。</p>
      </Empty>
    );
  }
  if (!board) return <LoadingCards count={3} />;

  const q = query.trim().toLowerCase();
  const matches = (name: string, summary: string | null) =>
    !q || name.toLowerCase().includes(q) || (summary ?? '').toLowerCase().includes(q);

  const queue = all.filter((i) => ['interested', 'prepared'].includes(stateOf(i)) && matches(i.name, i.summary));
  const fresh = all.filter(
    (i) => stateOf(i) === 'new' && (kind === 'all' || i.kind === kind) && matches(i.name, i.summary),
  );
  const tried = all.filter((i) => stateOf(i) === 'tried' && matches(i.name, i.summary));
  const archived = q ? (archive ?? []).filter((a) => matches(a.name, a.summary)).slice(0, 50) : [];
  const counts = new Map<ToolKind, number>();
  for (const i of all) if (stateOf(i) === 'new') counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">道具箱</h1>
        <p className="datebar__meta">
          新着 {board.items.length} 件（今日 +{board.stats.addedToday}
          {board.stats.resurfacedToday > 0 && ` ・ 再浮上 ${board.stats.resurfacedToday}`}） ・ 更新{' '}
          {new Date(board.updatedAt).toLocaleString('ja-JP')}
        </p>
      </div>

      {board.notes.map((note, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Notice>{note}</Notice>
        </div>
      ))}

      <p className="section-lead" style={{ marginTop: 4 }}>
        今日の記事・GitHub・MCP Registry・Claude Code のマーケットプレイス・クラウドの新サービスなどから、
        触れる道具を集めています。新着のまま 7 日たつと一覧から外れ（検索では引けます）、
        また話題に出たら戻ってきます。
      </p>

      {owner && <AddByUrl writable={writable} />}

      <div className="toolbox-search">
        <input
          type="search"
          className="toolbox-search__input"
          placeholder="道具の名前・説明で絞り込む（一覧から外れたものも探せます）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="道具を検索"
        />
      </div>

      {queue.length > 0 && (
        <section>
          <h2 className="section-title" id="tool-queue">
            PC で触る {queue.length}
          </h2>
          <p className="section-lead">「気になる」を付けた道具です。上から順に試してください。</p>
          <div className="tool-list">
            {queue.map((item) => (
              <ToolCard key={item.id} item={item} state={stateOf(item)} owner={owner} onChange={change} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="section-title" id="tool-new">
          新着 {fresh.length}
        </h2>
        <div className="tool-kinds" role="tablist" aria-label="種類で絞り込む">
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'all'}
            className={`tool-kinds__chip${kind === 'all' ? ' is-active' : ''}`}
            onClick={() => setKind('all')}
          >
            すべて
          </button>
          {KIND_ORDER.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`tool-kinds__chip${kind === k ? ' is-active' : ''}`}
              onClick={() => setKind(k)}
            >
              {KIND_LABELS[k]} {counts.get(k)}
            </button>
          ))}
        </div>
        {fresh.length === 0 ? (
          <p className="section-lead">該当する道具がありません。</p>
        ) : (
          <div className="tool-list">
            {fresh.map((item) => (
              <ToolCard key={item.id} item={item} state={stateOf(item)} owner={owner} onChange={change} />
            ))}
          </div>
        )}
      </section>

      {q && archived.length > 0 && (
        <section>
          <h2 className="section-title">一覧から外れたもの {archived.length}</h2>
          <ul className="tool-archive">
            {archived.map((a) => (
              <li key={a.id}>
                <a href={a.homepage} target="_blank" rel="noreferrer noopener">
                  {a.name}
                </a>
                <span className="tool__kind">{KIND_LABELS[a.kind]}</span>
                {a.state === 'passed' && <span className="tool__flag">見送り</span>}
                {a.summary && <span className="tool-archive__summary">{a.summary}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tried.length > 0 && (
        <details className="tool-tried">
          <summary className="section-title">触ったもの {tried.length}</summary>
          <div className="tool-list">
            {tried.map((item) => (
              <ToolCard key={item.id} item={item} state={stateOf(item)} owner={owner} onChange={change} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function ToolCard({
  item,
  state,
  owner,
  onChange,
}: {
  item: ToolBoardItem;
  state: ToolState;
  owner: boolean;
  onChange: (item: ToolBoardItem, state: ToolState, reason?: PassReason) => void;
}) {
  const [passing, setPassing] = useState(false);
  const t = item.trust;

  return (
    <article className={`tool${state === 'passed' ? ' tool--passed' : ''}`}>
      <div className="tool__head">
        <a className="tool__name" href={item.homepage} target="_blank" rel="noreferrer noopener">
          {item.name}
        </a>
        <span className="tool__kind">{KIND_LABELS[item.kind]}</span>
        {item.isNew && <span className="tool__flag tool__flag--new">NEW</span>}
        {item.resurfaced && <span className="tool__flag">再浮上</span>}
      </div>

      {item.summary && <p className="tool__summary">{item.summary}</p>}
      {item.replaces && <p className="tool__replaces">代わりになるもの: {item.replaces}</p>}

      <p className="tool__meta">
        {t.official && <span className="tool__trust tool__trust--official">公式</span>}
        {t.stars != null && <span>★ {t.stars.toLocaleString()}</span>}
        {t.author && <span>{t.author}</span>}
        {t.license && <span>{t.license}</span>}
        {t.archived && <span className="tool__trust tool__trust--warn">アーカイブ済み</span>}
        {item.requires.map((r) => (
          <span key={r} className="tool__req">
            {r}
          </span>
        ))}
      </p>

      {/* スキル・プラグイン・MCP は自分の環境でコードを動かす。出どころを確かめてから入れる */}
      {['skill', 'plugin', 'mcp'].includes(item.kind) && !t.official && (
        <p className="tool__caution">
          入れる前に、作者とリポジトリの中身（要求する権限・実行するコマンド）を確かめてください。
        </p>
      )}

      {item.seenIn.length > 0 && (
        <p className="tool__seen">
          見かけた場所:{' '}
          {item.seenIn.map((s, i) => (
            <span key={`${s.source}-${s.date}-${i}`}>
              {i > 0 && ' ・ '}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>
                  {sourceLabel(s.source)}
                </a>
              ) : (
                sourceLabel(s.source)
              )}{' '}
              <span className="faint">{s.date.slice(5).replace('-', '/')}</span>
            </span>
          ))}
        </p>
      )}

      {item.tryPrompt && <TryBlock prompt={item.tryPrompt} compact />}

      {owner && (
        <div className="tool__actions">
          {state === 'new' && (
            <button type="button" className="btn btn--sm" onClick={() => onChange(item, 'interested')}>
              気になる
            </button>
          )}
          {(state === 'interested' || state === 'prepared') && (
            <button type="button" className="btn btn--sm" onClick={() => onChange(item, 'new')}>
              取り消す
            </button>
          )}
          {state !== 'tried' && (
            <button type="button" className="btn btn--sm" onClick={() => onChange(item, 'tried')}>
              触った
            </button>
          )}
          {state !== 'passed' &&
            (passing ? (
              <select
                className="tool__reason"
                aria-label="見送る理由"
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  onChange(item, 'passed', e.target.value as PassReason);
                  setPassing(false);
                }}
              >
                <option value="" disabled>
                  見送る理由を選ぶ
                </option>
                {(Object.keys(PASS_REASON_LABELS) as PassReason[]).map((r) => (
                  <option key={r} value={r}>
                    {PASS_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            ) : (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPassing(true)}>
                見送る
              </button>
            ))}
          {state === 'passed' && <span className="tool__flag">見送り済み（翌朝から一覧に出ません）</span>}
        </div>
      )}
    </article>
  );
}

/** 「URL を貼って追加」。X の投稿・GitHub・npm・サービスのページのどれでもよい */
function AddByUrl({ writable }: { writable: boolean }) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'invalid' | 'failed'>('idle');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeSubmittedUrl(value);
    if (!url) {
      setStatus('invalid');
      return;
    }
    setStatus('sending');
    const ok = await submitToolUrl(url);
    setStatus(ok ? 'sent' : 'failed');
    if (ok) setValue('');
  };

  return (
    <form className="tool-add" onSubmit={submit}>
      <label className="tool-add__label" htmlFor="tool-add-url">
        URL を貼って追加
      </label>
      <div className="tool-add__row">
        <input
          id="tool-add-url"
          className="tool-add__input"
          type="url"
          inputMode="url"
          placeholder="https://x.com/…/status/… や GitHub・npm・サービスの URL"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setStatus('idle');
          }}
        />
        <button
          type="submit"
          className="btn btn--sm"
          disabled={!writable || status === 'sending' || !value.trim()}
        >
          追加
        </button>
      </div>
      <p className="tool-add__hint" role="status">
        {status === 'sent' && '受け付けました。翌朝の更新で「PC で触る」に並びます。'}
        {status === 'invalid' && 'https の URL を貼ってください。'}
        {status === 'failed' && '送信できませんでした。時間をおいてもう一度試してください。'}
        {!writable && 'Firebase が未設定のため送れません（README の「読者フィードバック」の設定が必要です）。'}
        {writable &&
          (status === 'idle' || status === 'sending') &&
          'X の投稿は本文中のリンクから道具を探します。追加したものは「気になる」として並びます。'}
      </p>
    </form>
  );
}
