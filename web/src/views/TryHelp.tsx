import { CopyButton } from '../components';

/**
 * 設定画面の「ヘルプ」。カードの「試し方」のプロンプトを、各サンドボックスで
 * 動かすまでの手順。
 *
 * カード側のボタンは押した瞬間の動きしか伝えられない（「開く」「貼る」）。
 * 開いた先でログインやインストールが要る環境では、そこで止まる人が出る。
 * 手順は環境ごとに違うので、環境ごとに畳んで、開いたものだけ読めるようにする。
 * 選び方の目安を先に置くのは、手順を読む前に「どれを開くか」が決まるようにするため。
 */

const INSTALL_CLAUDE = 'curl -fsSL https://claude.ai/install.sh | bash';
const INSTALL_CLAUDE_NPM = 'npm install -g @anthropic-ai/claude-code';

export function TryHelp() {
  return (
    <section className="settings-section help">
      <h2>ヘルプ: 「試し方」のプロンプトをサンドボックスで動かす</h2>
      <p>
        作るレーンのカードの「試し方」は、そのまま貼って試し始められるプロンプトです。
        下の「プロンプトをコピー」か、開く先のボタンを押すとクリップボードに入ります。
        あとは貼る先の環境を開いて、Claude Code に貼るだけです。ここには環境ごとの
        開き方と、初回だけ要る準備を書いてあります。
      </p>

      <h3 className="help__sub">どれを開くか</h3>
      <div className="help__tablewrap">
        <table className="help__table">
          <thead>
            <tr>
              <th>カードの「前提・注意」に書かれていること</th>
              <th>開く先</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>npm i</code> や <code>pip install</code> で済む。Mac が必須
              </td>
              <td>Claude Code で開く（この PC の Claude Desktop）</td>
            </tr>
            <tr>
              <td>
                <code>curl | bash</code> で何かを入れる、Docker や root が要る、壊しても構わない場所で試したい
              </td>
              <td>iximiuz Labs</td>
            </tr>
            <tr>
              <td>数日かけて触りたい、環境を残したい</td>
              <td>Codespaces</td>
            </tr>
            <tr>
              <td>スマホで読んでいて、あとは Claude に任せたい</td>
              <td>Claude アプリで開く（クラウドのセッション）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <details className="help__env" open>
        <summary>▶ Claude Code で開く（PC・Claude Desktop）</summary>
        <ol className="howto__steps">
          <li>
            <strong>ボタンを押す</strong>
            <span>
              Claude Desktop の Code タブが新しいセッションで開き、入力欄にプロンプトが入っています。
              ブラウザが初回だけ「Claude を開きますか」と聞くので許可してください。
              Claude Desktop が入っていなければ{' '}
              <a href="https://claude.ai/download" target="_blank" rel="noreferrer noopener">
                claude.ai/download
              </a>{' '}
              から入れます。
            </span>
          </li>
          <li>
            <strong>作業フォルダを選ぶ</strong>
            <span>
              リンクからフォルダは渡していないので、開いたあとに選びます。プロンプトの末尾で{' '}
              <code>~/lab/&lt;名前&gt;/</code> を作業ディレクトリにするよう指示しているので、
              あらかじめ <code>~/lab</code> を作っておき、それを選ぶと収まりがよいです。
            </span>
          </li>
          <li>
            <strong>読んでから送る</strong>
            <span>
              送るまで何も実行されません。送ると Claude が「何を・どの順で・何分で」を 3 行で
              提案してくるので、OK と返すと手順が始まります。
            </span>
          </li>
        </ol>
      </details>

      <details className="help__env">
        <summary>▶ Claude アプリで開く（スマホ）</summary>
        <ol className="howto__steps">
          <li>
            <strong>ボタンを押す</strong>
            <span>
              Claude アプリの Code タブが開き、入力欄にプロンプトが入っています。アプリが
              入っていなければブラウザで claude.ai が開きます。Claude Code が使えるプランが必要です。
            </span>
          </li>
          <li>
            <strong>リポジトリを選ぶ</strong>
            <span>
              クラウドのセッションなので、作業する GitHub リポジトリを選びます。試す用の
              空のリポジトリを 1 つ作っておくと迷いません。
            </span>
          </li>
          <li>
            <strong>送って、閉じてよい</strong>
            <span>
              クラウドで動くので、アプリを閉じても進みます。終わると通知が来て、結果は
              あとから同じセッションで読めます。
            </span>
          </li>
        </ol>
      </details>

      <details className="help__env">
        <summary>☁ iximiuz Labs（使い捨ての Ubuntu・Claude Code 入り）</summary>
        <ol className="howto__steps">
          <li>
            <strong>ボタンを押してサインインする</strong>
            <span>
              「Coding Agent Base」のプレイグラウンドが開きます。初回はアカウントを作ります。
              無料枠は同時 1 台・1 日 1 時間で、ディスクは終了時に消えます。
            </span>
          </li>
          <li>
            <strong>Claude Code にログインする</strong>
            <span>
              ターミナルで <code>claude</code> を起動すると、Claude Code は入っているので
              ログインだけ求められます。表示された URL をブラウザで開いて承認し、コードを
              ターミナルに貼ります。毎回やるのが面倒なら、手元の Mac で{' '}
              <code>claude setup-token</code> を 1 回作り、プレイグラウンドで{' '}
              <code>export CLAUDE_CODE_OAUTH_TOKEN=…</code> を打ってから起動すると
              ログイン画面が出ません。
            </span>
          </li>
          <li>
            <strong>貼る</strong>
            <span>Claude Code の入力欄にクリップボードのプロンプトを貼って送ります。</span>
          </li>
        </ol>
      </details>

      <details className="help__env">
        <summary>☁ Codespaces（永続する Ubuntu・GitHub）</summary>
        <ol className="howto__steps">
          <li>
            <strong>ボタンを押す</strong>
            <span>
              GitHub の空テンプレートで Codespace が作られます。初回は 1〜3 分、2 回目以降は
              「再開」で数十秒です。無料枠は 2 コアで月 60 時間。停止しても中身は残り、
              30 日使わないと消えます。
            </span>
          </li>
          <li>
            <strong>Claude Code を入れる</strong>
            <span>
              ブラウザの VS Code の下にあるターミナルで次を打ちます。入らなければ{' '}
              <code>{INSTALL_CLAUDE_NPM}</code> でも同じです。
            </span>
            <span className="help__cmd">
              <code>{INSTALL_CLAUDE}</code>
              <CopyButton text={INSTALL_CLAUDE} label="コピー" />
            </span>
          </li>
          <li>
            <strong>ログインして貼る</strong>
            <span>
              <code>claude</code> を起動してログインし（手順は iximiuz と同じ）、プロンプトを
              貼ります。停止・再開ではログインが残ります。環境を作り直すたびに省くなら、GitHub の
              Settings → Codespaces → Secrets に <code>CLAUDE_CODE_OAUTH_TOKEN</code>
              （<code>claude setup-token</code> の値）を登録しておくと環境変数として自動で入ります。
            </span>
          </li>
        </ol>
      </details>

      <details className="help__env">
        <summary>☁ Cloud Shell（予備・Google アカウント）</summary>
        <ol className="howto__steps">
          <li>
            <strong>ボタンを押す</strong>
            <span>
              Google Cloud Shell のターミナルが開きます。無料で週 50 時間、ホームの 5GB は
              残りますが、40 分無操作で VM が止まります。
            </span>
          </li>
          <li>
            <strong>Claude Code を入れて、ログインして、貼る</strong>
            <span>手順は Codespaces と同じです。</span>
          </li>
        </ol>
      </details>

      <p className="help__note">
        URL でプロンプトを渡せるのは Claude のアプリだけです。ほかの環境は開いた先に貼る形になるので、
        どのボタンを押してもクリップボードに全文が入るようにしてあります。
      </p>
    </section>
  );
}
