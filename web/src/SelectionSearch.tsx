import { useCallback, useEffect, useState } from 'react';
import { openQuickSearch } from './QuickSearch';

/**
 * 本文を選択したら、その場に「調べる」を出す。
 *
 * 読んでいて引っかかる語は、たいてい目の前にある。それをタイプし直させない。
 * 選択が消えたら一緒に消す（選択と一対一で出る／消えるので、閉じる操作は要らない）。
 *
 * 出す条件は絞ってある。長い文をまるごと選んでも AND 検索では引けないので、
 * 語や短い句のときだけ。
 */

const MIN_LEN = 2;
const MAX_LEN = 40;

interface Spot {
  text: string;
  x: number;
  y: number;
}

function readSelection(): Spot | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim().replace(/\s+/g, ' ');
  if (text.length < MIN_LEN || text.length > MAX_LEN) return null;
  // 改行をまたぐ選択は句ではなく段落なので拾わない
  if (/[。、.,!?]/.test(text)) return null;

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { text, x: rect.left + rect.width / 2, y: rect.top };
}

export function SelectionSearch() {
  const [spot, setSpot] = useState<Spot | null>(null);

  const sync = useCallback(() => setSpot(readSelection()), []);

  useEffect(() => {
    /*
     * 選択が終わった時点で読む。selectionchange は途中経過でも飛ぶので、
     * ドラッグ中に印が出たり消えたりする。
     *
     * 一手遅らせるのは、mouseup の時点ではまだ選択が確定していないことがあるため。
     * requestAnimationFrame ではなく setTimeout を使う——描画が止まっている
     * ときに rAF は呼ばれず、そこだけ印が出なくなる。
     */
    const onEnd = () => setTimeout(sync, 0);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
    document.addEventListener('keyup', onEnd);
    // 選択が解けたら消す。こちらは途中経過で消えても困らない
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSpot(null);
    };
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('scroll', sync, { passive: true });
    return () => {
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('keyup', onEnd);
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('scroll', sync);
    };
  }, [sync]);

  if (!spot) return null;

  return (
    <button
      type="button"
      className="selsearch"
      style={{ left: spot.x, top: spot.y }}
      /* mousedown で選択が解けるとテキストを取り損ねるので、押下の既定動作を止める */
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        openQuickSearch(spot.text);
        setSpot(null);
      }}
    >
      ⌕ 調べる
    </button>
  );
}
