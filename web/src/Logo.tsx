/**
 * 四角形を組み合わせたマーク。
 *
 * 大きい 1 枚と小さい 3 枚。「たくさん集めた中から 1 本を大きく扱う」という
 * このツールの中身をそのまま形にしている。大きい面だけアクセント色にして、
 * 残りは地の色に近づけて主従をつけた。
 *
 * 組み上がる順番は時計回り（左上 → 右上 → 右下 → 下）。DOM の順番が
 * そのまま時計回りになっているので、遅延を 1 枚ずつずらすだけで済む。
 *
 * 動きは昔のセルアニメの物理法則に寄せている。回りながら飛んできて、
 * 行き過ぎてから枠にぶつかり、一瞬ぺしゃんと潰れて、揺り返しながら収まる。
 * 各面の飛んでくる方向と回転量は --dx / --dy / --rot で個別に持つ。
 */
export function Logo() {
  return (
    <svg
      className="logo"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      {/* ① 深掘りした本命。左上へ、左手から回り込んで入る */}
      <rect
        className="logo__face logo__face--lead"
        x="0.5"
        y="0.5"
        width="11.5"
        height="11.5"
        rx="2"
        style={{ '--dx': '-7px', '--dy': '-4px', '--rot': '-38deg' } as React.CSSProperties}
      />
      {/* ② 右上。真上から落ちてくる */}
      <rect
        className="logo__face"
        x="13.5"
        y="0.5"
        width="6"
        height="5.5"
        rx="1.4"
        style={{ '--dx': '3px', '--dy': '-8px', '--rot': '44deg' } as React.CSSProperties}
      />
      {/* ③ 右下。右手から入る */}
      <rect
        className="logo__face"
        x="13.5"
        y="7.5"
        width="6"
        height="4.5"
        rx="1.4"
        style={{ '--dx': '8px', '--dy': '2px', '--rot': '34deg' } as React.CSSProperties}
      />
      {/* ④ 下の帯。下から突き上げて最後に蓋をする */}
      <rect
        className="logo__face"
        x="0.5"
        y="13.5"
        width="19"
        height="6"
        rx="1.8"
        style={{ '--dx': '-2px', '--dy': '9px', '--rot': '-16deg' } as React.CSSProperties}
      />
    </svg>
  );
}
