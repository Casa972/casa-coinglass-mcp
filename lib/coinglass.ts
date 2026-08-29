// Petit client pour l'API CoinGlass V4.
// Doc officielle : https://docs.coinglass.com/reference/getting-started-with-your-api

const BASE_URL = "https://open-api-v4.coinglass.com";

export class CoinglassError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function apiKey(): string {
  const key = process.env.COINGLASS_API_KEY;
  if (!key) {
    throw new Error(
      "COINGLASS_API_KEY manquante. Ajoute-la dans les variables d'environnement Vercel (jamais cote client)."
    );
  }
  return key;
}

// Appel generique GET vers un endpoint CoinGlass V4.
// `params` : objet de query params optionnels (symbol, interval, limit, exchange, etc.)
export async function coinglassGet<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      "CG-API-KEY": apiKey(),
      Accept: "application/json",
    },
    // les donnees derivees changent vite, on ne met jamais en cache
    cache: "no-store",
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new CoinglassError(
      `CoinGlass API ${res.status} sur ${path}`,
      res.status,
      json
    );
  }

  return json as T;
}

// --- Wrappers par famille de donnees, alignes sur le framework de Luc :
// CVD (taker buy/sell -> delta), OI, et funding rate, en confluence multi-timeframe.

export const CoinglassAPI = {
  // Open Interest
  openInterestOhlc: (params: {
    symbol: string;
    interval?: string; // ex: "1h", "4h", "1d"
    limit?: number;
    exchange?: string;
  }) => coinglassGet("/api/futures/openInterest/ohlc-history", params),

  openInterestByExchange: (params: { symbol: string }) =>
    coinglassGet("/api/futures/openInterest/exchange-list", params),

  // Funding Rate
  fundingRateOhlc: (params: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) => coinglassGet("/api/futures/fundingRate/ohlc-history", params),

  fundingRateByExchange: (params: { symbol: string }) =>
    coinglassGet("/api/futures/fundingRate/exchange-list", params),

  // Taker buy/sell volume -> base du CVD (delta cumule)
  takerBuySellVolume: (params: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) => coinglassGet("/api/futures/taker-buy-sell-volume/history", params),

  // Long/Short ratios
  globalLongShortRatio: (params: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) =>
    coinglassGet(
      "/api/futures/global-long-short-account-ratio/history",
      params
    ),

  topTraderLongShortRatio: (params: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) =>
    coinglassGet("/api/futures/top-long-short-account-ratio/history", params),

  // Liquidations
  liquidationHistory: (params: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) => coinglassGet("/api/futures/liquidation/history", params),

  liquidationAggregated: (params: {
    symbol: string;
    interval?: string;
    limit?: number;
  }) => coinglassGet("/api/futures/liquidation/aggregated-history", params),
};

// Calcule un CVD (cumulative volume delta) a partir d'une serie taker buy/sell volume.
// CoinGlass renvoie du volume buy/sell par bougie ; le CVD est la somme cumulee de (buy - sell).
export function computeCvdSeries(
  series: Array<{ time: number; buyVol: number; sellVol: number }>
) {
  let cumulative = 0;
  return series.map((point) => {
    const delta = point.buyVol - point.sellVol;
    cumulative += delta;
    return { time: point.time, delta, cvd: cumulative };
  });
}
