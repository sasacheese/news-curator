import { useEffect, useRef } from 'react';
import { safeUrl } from './format';
import type { AuthorDetail } from './types';

/**
 * 作者の詳細。ネイティブの <dialog> を使うので、
 * Esc で閉じる・フォーカストラップ・背景の不活性化はブラウザ任せにできる。
 */
export function AuthorModal({
  author,
  sourceLabel,
  onClose,
}: {
  author: AuthorDetail;
  sourceLabel: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const onCancel = () => onClose();
    dialog.addEventListener('close', onCancel);
    return () => dialog.removeEventListener('close', onCancel);
  }, [onClose]);

  const stats = [
    author.posts != null ? { label: '投稿', value: author.posts.toLocaleString() } : null,
    author.followers != null
      ? { label: 'フォロワー', value: author.followers.toLocaleString() }
      : null,
  ].filter((s): s is { label: string; value: string } => s !== null);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="author-modal-name"
      onClick={(e) => {
        // バックドロップ（dialog 要素自身）のクリックで閉じる
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="modal__body">
        <button
          type="button"
          className="modal__close"
          onClick={() => ref.current?.close()}
          aria-label="閉じる"
        >
          ×
        </button>

        <div className="author">
          {author.avatarUrl && (
            <img
              className="author__avatar"
              src={author.avatarUrl}
              alt=""
              width={56}
              height={56}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="author__id">
            <p className="author__name" id="author-modal-name">
              {author.name}
            </p>
            {author.handle && <p className="author__handle">{author.handle}</p>}
            <p className="author__source">{sourceLabel}</p>
          </div>
        </div>

        {author.bio && <p className="author__bio">{author.bio}</p>}

        {(author.organization || author.location) && (
          <dl className="author__meta">
            {author.organization && (
              <>
                <dt>所属</dt>
                <dd>{author.organization}</dd>
              </>
            )}
            {author.location && (
              <>
                <dt>拠点</dt>
                <dd>{author.location}</dd>
              </>
            )}
          </dl>
        )}

        {stats.length > 0 && (
          <div className="author__stats">
            {stats.map((s) => (
              <div className="stat" key={s.label}>
                <span className="stat__value">{s.value}</span>
                <span className="stat__label">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        <div className="author__links">
          {safeUrl(author.url) && (
            <a className="btn btn--sm" href={safeUrl(author.url)} target="_blank" rel="noreferrer noopener">
              プロフィール ↗
            </a>
          )}
          {(author.links ?? []).map((l) =>
            safeUrl(l.url) ? (
              <a
                key={l.url}
                className="btn btn--sm"
                href={safeUrl(l.url)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {l.label} ↗
              </a>
            ) : null,
          )}
        </div>
      </div>
    </dialog>
  );
}
