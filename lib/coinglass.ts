// Client pour l'API CoinGlass V4 - chemins verifies contre la doc officielle
// https://github.com/coinglass-official/coinglass-api-docs

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

// "BTC" -> "BTCUSDT" pour les endpoints qui attendent une paire de trading.
// Si l'utilisateur donne deja une paire (se termine par USDT/USD/USDC), on ne touche pas.
export function toPair(symbol: string): string {
  const s = symbol.toUpperCase().trim();
  if (/(USDT|USDC|USD)$/.test(s)) return s;
  return `${s}USDT`;
}

// "BTCUSDT" -> "BTC" pour les endpoints qui attendent le coin brut (pas une paire).
export function toCoin(symbol: string): string {
  return symbol.toUpperCase().trim().replace(/(USDT|USDC|USD)$/, "");
}

async function coinglassGet<T = unknown>(
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
    cache: "no-store",
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || (json && typeof json === "object" && "code" in json && json.code !== "0")) {
    throw new CoinglassError(
      `CoinGlass API erreur sur ${path}`,
      res.status,
      json
    );
  }

  return json as T;
}

// Defaults adaptes a l'usage de Luc : MEXC + Binance, day trading.
const DEFAULT_EXCHANGE = "Binance";
const DEFAULT_EXCHANGE_LIST = "Binance,MEXC";

export const CoinglassAPI = {
  // --- Open Interest ---
  openInterestHistory: (p: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) =>
    coinglassGet("/api/futures/open-interest/history", {
      exchange: p.exchange ?? DEFAULT_EXCHANGE,
      symbol: toPair(p.symbol),
      interval: p.interval ?? "1h",
      limit: p.limit ?? 50,
    }),

  openInterestByExchange: (p: { symbol: string }) =>
    coinglassGet("/api/futures/open-interest/exchange-list", {
      symbol: toCoin(p.symbol),
    }),

  // --- Funding Rate ---
  fundingRateHistory: (p: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) =>
    coinglassGet("/api/futures/funding-rate/history", {
      exchange: p.exchange ?? DEFAULT_EXCHANGE,
      symbol: toPair(p.symbol),
      interval: p.interval ?? "1h",
      limit: p.limit ?? 50,
    }),

  // Pas de parametres sur cet endpoint : renvoie tous les symboles.
  fundingRateByExchange: () =>
    coinglassGet<{ data: Array<{ symbol: string; [k: string]: unknown }> }>(
      "/api/futures/funding-rate/exchange-list"
    ),

  // --- CVD (calcule a partir du volume taker buy/sell agrege, dispo des Hobbyist) ---
  // Note : l'endpoint natif /api/futures/aggregated-cvd/history existe mais demande
  // le plan Startup ou +. Sur Hobbyist, on calcule le delta nous-memes.
  aggregatedTakerBuySellVolume: (p: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchangeList?: string;
  }) =>
    coinglassGet<{
      data: Array<{
        time: number;
        aggregated_buy_volume_usd: number;
        aggregated_sell_volume_usd: number;
      }>;
    }>("/api/futures/aggregated-taker-buy-sell-volume/history", {
      exchange_list: p.exchangeList ?? DEFAULT_EXCHANGE_LIST,
      symbol: toCoin(p.symbol),
      interval: p.interval ?? "1h",
      limit: p.limit ?? 50,
    }),

  // --- Long/Short ratio ---
  globalLongShortRatio: (p: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) =>
    coinglassGet("/api/futures/global-long-short-account-ratio/history", {
      exchange: p.exchange ?? DEFAULT_EXCHANGE,
      symbol: toPair(p.symbol),
      interval: p.interval ?? "1h",
      limit: p.limit ?? 50,
    }),

  topTraderLongShortRatio: (p: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchange?: string;
  }) =>
    coinglassGet("/api/futures/top-long-short-account-ratio/history", {
      exchange: p.exchange ?? DEFAULT_EXCHANGE,
      symbol: toPair(p.symbol),
      interval: p.interval ?? "1h",
      limit: p.limit ?? 50,
    }),

  // --- Liquidations (agrege Binance+MEXC par defaut) ---
  liquidationAggregated: (p: {
    symbol: string;
    interval?: string;
    limit?: number;
    exchangeList?: string;
  }) =>
    coinglassGet("/api/futures/liquidation/aggregated-history", {
      exchange_list: p.exchangeList ?? DEFAULT_EXCHANGE_LIST,
      symbol: toCoin(p.symbol),
      interval: p.interval ?? "1h",
      limit: p.limit ?? 50,
    }),
};

// Delta cumule (CVD) a partir d'une serie buy/sell volume.
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

// Screener funding rate : traite le dump complet (~2000 symboles) cote
// serveur et ne renvoie que le top N par cote, NORMALISE A L'HEURE - le
// champ funding_rate est deja en % (ex: -0.9464 = -0.9464%), donc pas de
// *100 ici. Sans cette normalisation un symbole a intervalle 1h (ex: ZKC)
// peut sembler moins extreme qu'un symbole a 4h alors qu'il paie plus vite.
type FundingScreenerRow = {
  symbol: string;
  exchange: string;
  fundingRatePerInterval: number;
  intervalHours: number;
  fundingRateHourly: number;
};

export function buildFundingScreener(
  raw: { data?: Array<{ symbol: string; stablecoin_margin_list?: Array<{ exchange: string; funding_rate?: number; funding_rate_interval?: number }> }> },
  opts: { limit?: number; exchanges?: string[] } = {}
) {
  const exchanges = opts.exchanges ?? ["Binance", "MEXC"];
  const limit = opts.limit ?? 15;

  const rows: FundingScreenerRow[] = [];
  for (const entry of raw.data ?? []) {
    for (const ex of entry.stablecoin_margin_list ?? []) {
      if (!exchanges.includes(ex.exchange)) continue;
      if (ex.funding_rate === undefined || !ex.funding_rate_interval) continue;
      rows.push({
        symbol: entry.symbol,
        exchange: ex.exchange,
        fundingRatePerInterval: ex.funding_rate,
        intervalHours: ex.funding_rate_interval,
        fundingRateHourly: ex.funding_rate / ex.funding_rate_interval,
      });
    }
  }

  // Garde la ligne la plus extreme par symbole (peu importe l'exchange) pour
  // chaque cote, pour eviter de polluer le top avec Binance+MEXC du meme coin.
  const worstBySymbol = new Map<string, FundingScreenerRow>();
  const bestBySymbol = new Map<string, FundingScreenerRow>();
  for (const r of rows) {
    const w = worstBySymbol.get(r.symbol);
    if (!w || r.fundingRateHourly < w.fundingRateHourly) worstBySymbol.set(r.symbol, r);
    const b = bestBySymbol.get(r.symbol);
    if (!b || r.fundingRateHourly > b.fundingRateHourly) bestBySymbol.set(r.symbol, r);
  }

  const mostNegativeHourly = [...worstBySymbol.values()]
    .sort((a, b) => a.fundingRateHourly - b.fundingRateHourly)
    .slice(0, limit);
  const mostPositiveHourly = [...bestBySymbol.values()]
    .sort((a, b) => b.fundingRateHourly - a.fundingRateHourly)
    .slice(0, limit);

  return { mostNegativeHourly, mostPositiveHourly };
}
