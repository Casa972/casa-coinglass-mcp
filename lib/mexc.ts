// lib/mexc.ts — Client MEXC Futures public (sans clé)

const MEXC_CONTRACT_BASE = "https://contract.mexc.com/api/v1";
const MEXC_API_BASE = "https://api.mexc.com";

export class MexcError extends Error {
  status: number; body: unknown;
  constructor(msg: string, status: number, body: unknown) {
    super(msg); this.status = status; this.body = body;
  }
}

async function mexcGet<T>(fullUrl: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(fullUrl);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { cache: "no-store" });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && typeof json === "object" && "success" in json && json.success === false)) {
    throw new MexcError(`MEXC API erreur sur ${fullUrl}`, res.status, json);
  }
  return json as T;
}

function toMexcPair(symbol: string): string {
  const s = symbol.toUpperCase().trim();
  if (s.includes("_")) return s;
  const base = s.replace(/(USDT|USDC|USD)$/, "");
  return `${base}_USDT`;
}

export type MexcTickerEntry = {
  symbol: string; lastPrice: number; bid1: number; ask1: number;
  volume24: number; amount24: number; fundingRate: number;
  nextSettleTime: number; indexPrice: number; fairPrice: number;
};

export type MexcScreenerRow = {
  symbol: string; symbolMexc: string;
  fundingRatePerInterval: number; fundingIntervalHours: number; fundingRateHourly: number;
  markPrice: number; quoteVolume24hUsd: number; nextFundingTime: number; source: "mexc";
};

export const MexcAPI = {
  fundingRate: (p: { symbol: string }) =>
    mexcGet(`${MEXC_CONTRACT_BASE}/contract/funding_rate/${toMexcPair(p.symbol)}`),

  bulkTicker: async (): Promise<MexcTickerEntry[]> => {
    const data = await mexcGet<{ success: boolean; data: MexcTickerEntry[] }>(`${MEXC_CONTRACT_BASE}/contract/ticker`);
    return data.data ?? [];
  },

  fundingScreener: async (p: { limit?: number; minVolumeUsd?: number }): Promise<{ mostNegativeHourly: MexcScreenerRow[]; mostPositiveHourly: MexcScreenerRow[] }> => {
    const tickers = await MexcAPI.bulkTicker();
    const minVol = p.minVolumeUsd ?? 3_000_000;
    const limit = p.limit ?? 500; // retourner beaucoup pour le merge avec Binance

    const rows: MexcScreenerRow[] = tickers
      .filter(t => t.symbol.endsWith("_USDT") && t.fundingRate !== undefined && (t.amount24 ?? t.volume24 * t.lastPrice) >= minVol)
      .map(t => ({
        symbol: t.symbol.replace("_USDT", "USDT"),
        symbolMexc: t.symbol,
        fundingRatePerInterval: t.fundingRate,
        fundingIntervalHours: 8,
        fundingRateHourly: t.fundingRate / 8,
        markPrice: t.fairPrice ?? t.lastPrice,
        quoteVolume24hUsd: t.amount24 ?? t.volume24 * t.lastPrice,
        nextFundingTime: t.nextSettleTime,
        source: "mexc" as const,
      }));

    return {
      mostNegativeHourly: [...rows].sort((a, b) => a.fundingRateHourly - b.fundingRateHourly).slice(0, limit),
      mostPositiveHourly: [...rows].sort((a, b) => b.fundingRateHourly - a.fundingRateHourly).slice(0, limit),
    };
  },
};
