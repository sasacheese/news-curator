/**
 * 四角形を組み合わせたマーク。
 *
 * 大きい 1 枚と小さい 3 枚。「たくさん集めた中から 1 本を大きく扱う」という
 * このツールの中身をそのまま形にしている。大きい面だけアクセント色にして、
 * 残りは地の色に近づけて主従をつけた。
 *
 * 表示時に組み上がるアニメーションをして、そのあとは 30 秒ごとに繰り返す。
 * 各面が別方向から少し回りながら入ってくる（方向は --dx / --dy / --rot）。
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
      {/* 深掘りした本命 */}
      <rect
        className="logo__face logo__face--lead"
        x="0.5"
        y="0.5"
        width="11.5"
        height="11.5"
        rx="2"
        style={{ '--dx': '-4px', '--dy': '-4px', '--rot': '-18deg' } as React.CSSProperties}
      />
      {/* 集めたもの */}
      <rect
        className="logo__face"
        x="13.5"
        y="0.5"
        width="6"
        height="5.5"
        rx="1.4"
        style={{ '--dx': '5px', '--dy': '-4px', '--rot': '16deg' } as React.CSSProperties}
      />
      <rect
        className="logo__face"
        x="13.5"
        y="7.5"
        width="6"
        height="4.5"
        rx="1.4"
        style={{ '--dx': '6px', '--dy': '2px', '--rot': '12deg' } as React.CSSProperties}
      />
      <rect
        className="logo__face"
        x="0.5"
        y="13.5"
        width="19"
        height="6"
        rx="1.8"
        style={{ '--dx': '0px', '--dy': '6px', '--rot': '-6deg' } as React.CSSProperties}
      />
    </svg>
  );
}
