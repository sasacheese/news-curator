import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getWalkMinutes, subscribeWalkMinutes } from './walkerClock';

/** 吹き出しを出している時間。往復の長さに関係なく実時間で決める */
const SAY_MS = 3600;

/**
 * 折り返しの瞬間に合わせて吹き出しを出す。
 *
 * タイミングはアニメーション自身の時計から取る。setTimeout で「往復の半分後」を
 * 予約する作りにしていたら、タブが背面に回るとずれた——CSS アニメーションは
 * 止まるのに setTimeout は進むので、猫が動いていないのに吹き出しが出る。
 *
 * そこで、往復の半分の長さを持つだけのアニメーション（walker-half）を重ねて、
 * その animationiteration を折り返しの合図にしている。アニメーションが止まれば
 * 合図も止まるので、位置と必ず一致する。
 *
 * 半周ごとに来るので、折り返し（往路の終わり）と出発点（復路の終わり）の
 * 両方で発火する。往復アニメーションの進捗を見て、折り返し側だけ拾う。
 *
 * 吹き出しの長さをキーフレームの % で表すことはできない。往復が 3 分の日と
 * 90 分の日で、同じ % が 1 秒と 30 秒になってしまう。
 */
function useTurnCue(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [saying, setSaying] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hide: number | undefined;

    function onIteration(e: AnimationEvent) {
      if (e.animationName !== 'walker-half') return;
      const tour = el
        ?.getAnimations()
        .find((a) => (a as CSSAnimation).animationName === 'walker-tour');
      const total = Number(tour?.effect?.getComputedTiming().duration ?? 0);
      if (!tour || !total) return;

      // 往路の終わり（=画面の右端）でだけ喋る。出発点に戻ったときは黙っている
      const progress = (Number(tour.currentTime ?? 0) % total) / total;
      if (progress < 0.25 || progress > 0.75) return;

      setSaying(true);
      window.clearTimeout(hide);
      hide = window.setTimeout(() => setSaying(false), SAY_MS);
    }

    el.addEventListener('animationiteration', onIteration);
    return () => {
      el.removeEventListener('animationiteration', onIteration);
      window.clearTimeout(hide);
      setSaying(false);
    };
  }, [ref]);

  return saying;
}

/**
 * 画面の下端を歩く猫。
 *
 * 実用の役には立たない。毎朝コーヒーを飲みながら読む画面なので、
 * 部屋の隅を猫が横切るくらいの気配があっていい、という以上の意図はない。
 *
 * 左端から出発して、読了目安ぴったりで往復し終わる。読み終わる頃に
 * 出発点へ戻ってくるので、猫の位置が残り時間の目安になる。
 * 折り返しのとき（=ちょうど半分）だけ吹き出しが出る。
 *
 * 邪魔にならないための条件をいくつか守っている。
 * - 下端に置く（読んでいる行を横切らない）
 * - 18px・text-faint 相当（視線を引かない）
 * - position: fixed + transform だけで動かす（本文のレイアウトに触らない）
 * - prefers-reduced-motion では出さない（歩かない猫を置く意味がない）
 *
 * クリックすると跳ねる。気づいた人だけの取り分。
 */
export function Walker() {
  const minutes = useSyncExternalStore(subscribeWalkMinutes, getWalkMinutes, getWalkMinutes);
  const [hopping, setHopping] = useState(false);
  const timer = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const saying = useTurnCue(root);

  function hop() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setHopping(true);
    // アニメーションと同じ長さで戻す（animationend はホバー中の一時停止と噛み合わない）
    timer.current = window.setTimeout(() => setHopping(false), 620);
  }

  const classes = ['walker'];
  if (hopping) classes.push('walker--hop');
  if (saying) classes.push('walker--saying');

  return (
    <div
      ref={root}
      className={classes.join(' ')}
      // 往復 1 周 = 読了目安。読み終わる頃に出発点へ戻ってくる
      style={{ '--walk-duration': `${minutes * 60}s` } as React.CSSProperties}
    >
      {/*
        吹き出しは反転する層の外に置く。中に入れると折り返しで scaleX(-1) を
        受けて文字が鏡文字になる。
      */}
      <span className="walker__say" role="status">
        あと半分にゃ！
      </span>
      <span className="walker__flip">
        {/*
          猫そのものはクリックを受ける。18px しかないので本文の邪魔にはならず、
          ホバーで歩きを止めるとつまめた感じが出る。
        */}
        <button
          type="button"
          className="walker__cat"
          onClick={hop}
          aria-label="猫。クリックすると跳ねます"
          title={
            minutes >= 1
              ? `読了目安 ${Math.round(minutes)} 分で画面を往復します`
              : `${Math.round(minutes * 60)} 秒で画面を往復します（動作確認用の設定）`
          }
        >
          <svg viewBox="0 0 28 18" width="28" height="18" aria-hidden="true" focusable="false">
            {/* しっぽ。歩きに合わせて揺れる */}
            <path
              className="walker__tail"
              d="M7 11.6 C3 12.2 1.8 7.6 4.4 5.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            {/* 耳。頭より先に描いて、付け根を頭で隠す */}
            <path d="M17.9 5.9 L18.6 1.9 L21.2 4.7 Z" />
            <path d="M22.3 4.6 L25 2.3 L25.2 6.5 Z" />
            {/* 頭 */}
            <circle cx="21.2" cy="8.2" r="4.1" />
            {/* 胴 */}
            <ellipse cx="13.6" cy="10.6" rx="6.9" ry="3.6" />
            {/*
              足は胴より後に描く。先に描くと胴の楕円に覆われて、
              8 倍に拡大しても足が生えていないように見えた。
            */}
            <rect className="walker__leg walker__leg--back" x="9.1" y="11.6" width="1.8" height="5.6" rx="0.9" />
            <rect className="walker__leg walker__leg--front" x="16.9" y="11.6" width="1.8" height="5.6" rx="0.9" />
            {/* 目。地の色で抜いて、塗り足さずに済ませる */}
            <circle className="walker__eye" cx="22.8" cy="7.7" r="0.62" />
          </svg>
        </button>
      </span>
    </div>
  );
}
