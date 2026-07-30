import type { Digest, IndexEntry, Manifest, TopicsConfig } from './types';

const BASE = import.meta.env.BASE_URL;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} の取得に失敗しました (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export function loadManifest(): Promise<Manifest> {
  return getJson<Manifest>('data/manifest.json');
}

export function loadDigest(date: string): Promise<Digest> {
  return getJson<Digest>(`data/digests/${date}.json`);
}

export function loadIndexShard(month: string): Promise<IndexEntry[]> {
  return getJson<IndexEntry[]>(`data/index/${month}.json`);
}

export function loadTopicsConfig(): Promise<TopicsConfig> {
  return getJson<TopicsConfig>('config/topics.json');
}

/** 検索インデックスをまとめて読み込む（新しい月から） */
export async function loadIndex(months: string[]): Promise<IndexEntry[]> {
  const shards = await Promise.all(
    months.map((m) => loadIndexShard(m).catch(() => [] as IndexEntry[])),
  );
  return shards.flat();
}
