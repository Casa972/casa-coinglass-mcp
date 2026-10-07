// lib/hyperliquid.ts — Fallback gratuit si Binance geo-bloqué (451)
// POST https://api.hyperliquid.xyz/info — pas de clé API

const BASE_URL = "https://api.hyperliquid.xyz";

export class HyperliquidError extends Error {
  status: number; body: unknown;
  constructor(msg: string, status: number, body: unknown) {
    super(msg); this.status = status; this.body = body;
  }
}

async function hlPost<T>(body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new HyperliquidError("Hyperliquid API erreur", res.status, json);
  return json as T;
}

type HLMeta = { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> };
type HLAssetCtx = {
  funding: string; openInterest: string; prevDayPx: string;
  dayNtlVlm: string; oraclePx: string; markPx: string;
};

export type HLScreenerRow = {
  symbol: string; symbolFull: string;
  fundingRatePerInterval: number; fundingIntervalHours: number; fundingRateHourly: number;
  markPrice: number; openInterestUsd: number; volume24hUsd: number; source: "hyperliquid";
};

export const HyperliquidAPI = {
  async metaAndAssetCtxs(): Promise<[HLMeta, HLAssetCtx[]]> {
    return hlPost({ type: "metaAndAssetCtxs" });
  },

  async buildScreenerRows(minVolumeUsd = 3_000_000): Promise<HLScreenerRow[]> {
    const [meta, ctxs] = await hlPost<[HLMeta, HLAssetCtx[]]>({ type: "metaAndAssetCtxs" });
    return meta.universe
      .map((asset, i) => {
        const ctx = ctxs[i];
        if (!ctx) return null;
        const markPrice = Number(ctx.markPx);
        const fundingRate = Number(ctx.funding); // déjà normalisé à 1h sur HL
        return {
          symbol: asset.name,
          symbolFull: `${asset.name}USDT`,
          fundingRatePerInterval: fundingRate,
          fundingIntervalHours: 1,
          fundingRateHourly: fundingRate,
          markPrice,
          openInterestUsd: Number(ctx.openInterest) * markPrice,
          volume24hUsd: Number(ctx.dayNtlVlm),
          source: "hyperliquid" as const,
        };
      })
      .filter((r): r is HLScreenerRow => r !== null && r.markPrice > 0 && r.volume24hUsd >= minVolumeUsd);
  },

  async fundingHistory(coin: string, startTime: number, endTime?: number) {
    return hlPost<Array<{ coin: string; fundingRate: string; premium: string; time: number }>>({
      type: "fundingHistory", coin, startTime, endTime: endTime ?? Date.now(),
    });
  },

  async openInterestAndFunding(symbolUsdt: string): Promise<{ openInterestUsd: number; fundingRateHourly: number; markPrice: number } | null> {
    const [meta, ctxs] = await hlPost<[HLMeta, HLAssetCtx[]]>({ type: "metaAndAssetCtxs" });
    const coin = symbolUsdt.replace(/USDT$/i, "").toUpperCase();
    const idx = meta.universe.findIndex(a => a.name.toUpperCase() === coin);
    if (idx === -1) return null;
    const ctx = ctxs[idx];
    const markPrice = Number(ctx.markPx);
    return {
      openInterestUsd: Number(ctx.openInterest) * markPrice,
      fundingRateHourly: Number(ctx.funding),
      markPrice,
    };
  },
};
