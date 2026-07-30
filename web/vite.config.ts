import { createReadStream } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** dev では中継し、build では dist/ 配下にコピーする外部ディレクトリ */
const MOUNTS = [
  { route: 'data', dir: resolve(REPO_ROOT, 'data') },
  { route: 'config', dir: resolve(REPO_ROOT, 'config') },
] as const;

/**
 * ダイジェスト JSON と設定はリポジトリ直下に置く（Git で差分を追えるようにするため）。
 * web/public に置かず、ここでマウントして配信する。
 */
function repoDataPlugin(base: string): Plugin {
  return {
    name: 'news-curator-repo-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        // dev サーバのミドルウェアには base 付きのパスが来るので、両方を受ける
        const found = MOUNTS.map((m) => {
          for (const prefix of [`${base}${m.route}/`, `/${m.route}/`]) {
            if (url.startsWith(prefix)) return { mount: m, rel: url.slice(prefix.length) };
          }
          return null;
        }).find((v) => v !== null);
        if (!found) return next();

        const { mount, rel } = found;
        const filePath = resolve(mount.dir, rel);
        if (rel.includes('..') || !filePath.startsWith(mount.dir)) {
          res.statusCode = 400;
          return res.end('bad request');
        }

        stat(filePath).then(
          (s) => {
            if (!s.isFile()) {
              res.statusCode = 404;
              return res.end('not found');
            }
            res.setHeader(
              'content-type',
              extname(filePath) === '.json' ? 'application/json; charset=utf-8' : 'text/plain',
            );
            res.setHeader('cache-control', 'no-cache');
            createReadStream(filePath).pipe(res);
          },
          () => {
            res.statusCode = 404;
            res.end('not found');
          },
        );
      });
    },
    async closeBundle() {
      for (const mount of MOUNTS) {
        try {
          await cp(mount.dir, resolve(import.meta.dirname, 'dist', mount.route), {
            recursive: true,
          });
        } catch {
          // 初回ビルドでまだディレクトリが無い場合はスキップ
        }
      }
    },
  };
}

// GitHub Pages のプロジェクトサイト配下に置くため。別の場所に置くなら BASE_PATH を渡す。
const BASE = process.env.BASE_PATH ?? '/news-curator/';

export default defineConfig({
  base: BASE,
  plugins: [react(), repoDataPlugin(BASE)],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
