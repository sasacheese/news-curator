/**
 * 設定ファイルの編集を GitHub 側に任せるためのリンク生成。
 *
 * ブラウザに personal access token を持たせて Contents API を叩く方式はやめた。
 * 置き場所（公開サイトの localStorage）に対して権限が強すぎるうえ、書き込みの
 * 認可はリポジトリの権限そのもので足りる。GitHub の Web エディタへ飛ばせば、
 * ログイン済みで権限があれば編集でき、無ければできない——それが正しい境界。
 * リポジトリを private にしてもこの方式のまま動く。
 */

/** owner/repo 形式か。UI 上の分岐にしか使わないので緩めの判定でよい */
export function isRepoSlug(repo: string | null | undefined): repo is string {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo);
}

export function editUrl(repo: string, path: string, branch = 'main'): string {
  return `https://github.com/${repo}/edit/${branch}/${path}`;
}
