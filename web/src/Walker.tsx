import { useRef, useState } from 'react';

/**
 * 画面の下端をゆっくり往復して歩く猫。
 *
 * 実用の役には立たない。毎朝コーヒーを飲みながら読む画面なので、
 * 部屋の隅を猫が横切るくらいの気配があっていい、という以上の意図はない。
 *
 * 邪魔にならないための条件をいくつか守っている。
 * - 下端に置く（読んでいる行を横切らない）
 * - 80 秒で往復する（視界の端で動いても気にならない速さ）
 * - 18px・text-faint 相当（視線を引かない）
 * - position: fixed + transform だけで動かす（本文のレイアウトに触らない）
 * - prefers-reduced-motion では出さない（歩かない猫を置く意味がない）
 *
 * クリックすると跳ねる。気づいた人だけの取り分。
 */
export function Walker() {
  const [hopping, setHopping] = useState(false);
  const timer = useRef<number | null>(null);

  function hop() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setHopping(true);
    // アニメーションと同じ長さで戻す（animationend はホバー中の一時停止と噛み合わない）
    timer.current = window.setTimeout(() => setHopping(false), 620);
  }

  return (
    <div className={hopping ? 'walker walker--hop' : 'walker'}>
      {/*
        猫そのものはクリックを受ける。18px しかないので本文の邪魔にはならず、
        ホバーで歩きを止めるとつまめた感じが出る。
      */}
      <button
        type="button"
        className="walker__cat"
        onClick={hop}
        aria-label="猫。クリックすると跳ねます"
        title="なでる"
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
    </div>
  );
}
