// lib/binance.ts — Client Binance Futures USDS-M (sans clé API)
// Détecte automatiquement le blocage geo (451/403) et bascule sur Hyperliquid.

import { HyperliquidAPI, type HLScreenerRow } from "@/lib/hyperliquid";

const BASE_URL = "https://fapi.binance.com";

export class BinanceError extends Error {
  status: number; body: unknown;
  constructor(msg: string, status: number, body: unknown) {
    super(msg); this.status = status; this.body = body;
  }
}
export class BinanceGeoBlockError extends BinanceError {
  constructor(body: unknown) { super("Binance geo-bloqué (451/403) — fallback Hyperliquid", 451, body); }
}

async function binanceGet<T = unknown>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  const json = await res.json().catch(() => null);
  if (res.status === 451 || res.status === 403) throw new BinanceGeoBlockError(json);
  if (!res.ok) throw new BinanceError(`Binance API erreur sur ${path}`, res.status, json);
  return json as T;
}

function toBinancePair(symbol: string): string {
  const s = symbol.toUpperCase().trim();
  return /(USDT|USDC|USD)$/.test(s) ? s : `${s}USDT`;
}

// Binance /futures/data/* utilisent "period" pas "interval"
const PERIOD_MAP: Record<string, string> = {
  "1m": "5m", "3m": "5m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h",
  "8h": "4h", "12h": "12h", "1d": "1d", "1w": "1d",
};
function toBinancePeriod(interval?: string): string {
  return PERIOD_MAP[interval ?? "1h"] ?? "1h";
}

type PremiumIndexEntry = { symbol: string; markPrice: string; lastFundingRate: string; nextFundingTime: number; time: number };
type FundingInfoEntry = { symbol: string; fundingIntervalHours: number };
type Ticker24hEntry = { symbol: string; quoteVolume: string };
type OIHistEntry = { symbol: string; sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number };
type LSRatioEntry = { symbol: string; longShortRatio: string; longAccount: string; shortAccount: string; timestamp: number };
type KlineEntry = [number, string, string, string, string, string, number, string, number, string, string, string];

export type ScreenerRow = {
  symbol: string; fundingRatePerInterval: number; fundingIntervalHours: number;
  fundingRateHourly: number; markPrice: number; quoteVolume24hUsd: number;
  nextFundingTime: number; source: "binance" | "hyperliquid";
};

// Cache court pour éviter de re-fetcher premiumIndex toutes les 30s
let _screenerCache: { rows: ScreenerRow[]; ts: number } | null = null;
const CACHE_MS = 30_000;

async function fetchAllBinanceRows(minVolumeUsd: number): Promise<ScreenerRow[]> {
  if (_screenerCache && Date.now() - _screenerCache.ts < CACHE_MS) {
    return _screenerCache.rows.filter(r => r.quoteVolume24hUsd >= minVolumeUsd);
  }
  const [premium, fundingInfo, tickers] = await Promise.all([
    binanceGet<PremiumIndexEntry[]>("/fapi/v1/premiumIndex"),
    binanceGet<FundingInfoEntry[]>("/fapi/v1/fundingInfo"),
    binanceGet<Ticker24hEntry[]>("/fapi/v1/ticker/24hr"),
  ]);
  const intervalMap = new Map<string, number>();
  for (const f of fundingInfo) intervalMap.set(f.symbol, f.fundingIntervalHours);
  const volumeMap = new Map<string, number>();
  for (const t of tickers) volumeMap.set(t.symbol, Number(t.quoteVolume) || 0);
  const rows: ScreenerRow[] = premium
    .filter(p => p.symbol.endsWith("USDT") && p.lastFundingRate !== "")
    .map(p => {
      const rate = Number(p.lastFundingRate);
      const intervalHours = intervalMap.get(p.symbol) ?? 8;
      return {
        symbol: p.symbol,
        fundingRatePerInterval: rate,
        fundingIntervalHours: intervalHours,
        fundingRateHourly: rate / intervalHours,
        markPrice: Number(p.markPrice),
        quoteVolume24hUsd: volumeMap.get(p.symbol) ?? 0,
        nextFundingTime: p.nextFundingTime,
        source: "binance" as const,
      };
    });
  _screenerCache = { rows, ts: Date.now() };
  return rows.filter(r => r.quoteVolume24hUsd >= minVolumeUsd);
}

export const BinanceAPI = {
  fundingRate: async (p: { symbol: string }) => {
    const sym = toBinancePair(p.symbol);
    try {
      return await binanceGet<PremiumIndexEntry>("/fapi/v1/premiumIndex", { symbol: sym });
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        const d = await HyperliquidAPI.openInterestAndFunding(sym);
        if (!d) throw new Error(`${sym} non trouvé sur Hyperliquid`);
        return { symbol: sym, markPrice: String(d.markPrice), lastFundingRate: String(d.fundingRateHourly), nextFundingTime: Date.now() + 3_600_000, time: Date.now(), source: "hyperliquid" };
      }
      throw err;
    }
  },

  // Retourne TOUTES les lignes pour le screener
  allRows: async (minVolumeUsd = 3_000_000): Promise<ScreenerRow[]> => {
    try {
      return await fetchAllBinanceRows(minVolumeUsd);
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        const rows = await HyperliquidAPI.buildScreenerRows(minVolumeUsd);
        return rows.map(r => ({
          symbol: r.symbolFull,
          fundingRatePerInterval: r.fundingRatePerInterval,
          fundingIntervalHours: 1,
          fundingRateHourly: r.fundingRateHourly,
          markPrice: r.markPrice,
          quoteVolume24hUsd: r.volume24hUsd,
          nextFundingTime: Date.now() + 3_600_000,
          source: "hyperliquid" as const,
        }));
      }
      throw err;
    }
  },

  fundingScreener: async (p: { limit?: number; minVolumeUsd?: number }) => {
    const rows = await BinanceAPI.allRows(p.minVolumeUsd ?? 3_000_000);
    const limit = p.limit ?? 15;
    return {
      mostNegativeHourly: [...rows].sort((a, b) => a.fundingRateHourly - b.fundingRateHourly).slice(0, limit),
      mostPositiveHourly: [...rows].sort((a, b) => b.fundingRateHourly - a.fundingRateHourly).slice(0, limit),
    };
  },

  fundingRateHistory: async (p: { symbol: string; limit?: number }) => {
    const sym = toBinancePair(p.symbol);
    try {
      return await binanceGet<Array<{ symbol: string; fundingRate: string; fundingTime: number }>>(
        "/fapi/v1/fundingRate", { symbol: sym, limit: p.limit ?? 100 }
      );
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        const coin = sym.replace("USDT", "");
        const startTime = Date.now() - (p.limit ?? 100) * 8 * 3_600_000;
        return HyperliquidAPI.fundingHistory(coin, startTime);
      }
      throw err;
    }
  },

  openInterest: async (p: { symbol: string }) => {
    const sym = toBinancePair(p.symbol);
    try {
      return await binanceGet<{ symbol: string; openInterest: string; time: number }>(
        "/fapi/v1/openInterest", { symbol: sym }
      );
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        const d = await HyperliquidAPI.openInterestAndFunding(sym);
        if (!d) throw new Error(`${sym} non trouvé sur Hyperliquid`);
        return { symbol: sym, openInterest: String(d.openInterestUsd / d.markPrice), openInterestUsd: d.openInterestUsd, time: Date.now(), source: "hyperliquid" };
      }
      throw err;
    }
  },

  openInterestHistory: async (p: { symbol: string; interval?: string; limit?: number }) => {
    const sym = toBinancePair(p.symbol);
    const period = toBinancePeriod(p.interval);
    try {
      const data = await binanceGet<OIHistEntry[]>(
        "/futures/data/openInterestHist", { symbol: sym, period, limit: p.limit ?? 50 }
      );
      return data.map(d => ({
        time: d.timestamp,
        openInterest: Number(d.sumOpenInterest),
        openInterestUsd: Number(d.sumOpenInterestValue),
      }));
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        const d = await HyperliquidAPI.openInterestAndFunding(sym);
        if (!d) return [];
        return [{ time: Date.now(), openInterest: d.openInterestUsd / d.markPrice, openInterestUsd: d.openInterestUsd }];
      }
      throw err;
    }
  },

  // Retourne aussi le changement % sur 4h/1h (utile pour squeeze scan)
  openInterestWithChange: async (p: { symbol: string }) => {
    const sym = toBinancePair(p.symbol);
    try {
      const [hist4h, hist1h] = await Promise.all([
        binanceGet<OIHistEntry[]>("/futures/data/openInterestHist", { symbol: sym, period: "4h", limit: 2 }),
        binanceGet<OIHistEntry[]>("/futures/data/openInterestHist", { symbol: sym, period: "1h", limit: 2 }),
      ]);
      const calcChange = (arr: OIHistEntry[]) => {
        if (arr.length < 2) return null;
        const prev = Number(arr[0].sumOpenInterestValue);
        const curr = Number(arr[arr.length - 1].sumOpenInterestValue);
        return prev > 0 ? ((curr - prev) / prev) * 100 : null;
      };
      return {
        open_interest_change_percent_4h: calcChange(hist4h),
        open_interest_change_percent_1h: calcChange(hist1h),
        open_interest_usd: hist4h.length ? Number(hist4h[hist4h.length - 1].sumOpenInterestValue) : null,
      };
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        const d = await HyperliquidAPI.openInterestAndFunding(sym);
        return { open_interest_change_percent_4h: null, open_interest_change_percent_1h: null, open_interest_usd: d?.openInterestUsd ?? null };
      }
      throw err;
    }
  },

  longShortRatio: async (p: { symbol: string; type?: "global" | "topPosition"; interval?: string; limit?: number }) => {
    const sym = toBinancePair(p.symbol);
    const period = toBinancePeriod(p.interval);
    const endpoint = p.type === "topPosition"
      ? "/futures/data/topLongShortPositionRatio"
      : "/futures/data/globalLongShortAccountRatio";
    try {
      return await binanceGet<LSRatioEntry[]>(endpoint, { symbol: sym, period, limit: p.limit ?? 50 });
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        throw new Error("L/S ratio non disponible hors Binance — utilisez get_coinalyze_long_short_ratio (nécessite COINALYZE_API_KEY)");
      }
      throw err;
    }
  },

  cvdFromKlines: async (p: { symbol: string; interval?: string; limit?: number }) => {
    const sym = toBinancePair(p.symbol);
    try {
      const klines = await binanceGet<KlineEntry[]>(
        "/fapi/v1/klines", { symbol: sym, interval: p.interval ?? "1h", limit: p.limit ?? 50 }
      );
      let cumulative = 0;
      return klines.map(k => {
        const quoteVol = Number(k[7]);
        const takerBuyQuote = Number(k[10]);
        const takerSellQuote = quoteVol - takerBuyQuote;
        const delta = takerBuyQuote - takerSellQuote;
        cumulative += delta;
        return { time: k[0], buyVol: takerBuyQuote, sellVol: takerSellQuote, delta, cvd: cumulative };
      });
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        throw new Error("CVD non disponible (Binance geo-bloqué) — ajoutez COINALYZE_API_KEY pour utiliser get_price_history");
      }
      throw err;
    }
  },

  klines: async (p: { symbol: string; interval?: string; limit?: number }) => {
    const sym = toBinancePair(p.symbol);
    try {
      const klines = await binanceGet<KlineEntry[]>(
        "/fapi/v1/klines", { symbol: sym, interval: p.interval ?? "1h", limit: p.limit ?? 50 }
      );
      return klines.map(k => ({
        time: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
        close: Number(k[4]), volume: Number(k[5]), quoteVolume: Number(k[7]),
      }));
    } catch (err) {
      if (err instanceof BinanceGeoBlockError) {
        throw new Error("Klines Binance geo-bloquées — utilisez get_price_history (nécessite COINALYZE_API_KEY)");
      }
      throw err;
    }
  },
};
