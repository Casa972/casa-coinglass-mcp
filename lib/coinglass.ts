// Client pour l'API CoinGlass V4 - chemins verifies contre la doc officielle
// https://github.com/coinglass-official/coinglass-api-docs

import { CoinalyzeAPI } from "@/lib/coinalyze";

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

// Scan multi-criteres : reproduit la confluence identifiee manuellement sur
// HNT avant son pump de +19% (funding tres negatif + OI qui construit + CVD
// acheteur net + liquidations dominees par les shorts). Part des candidats
// deja tries par buildFundingScreener puis approfondit chacun.
//
// COUT API : 1 (screener) + 3 appels par candidat. Le plan Hobbyist est
// limite a 30 requetes/minute - garder candidateCount <= 8 en usage normal
// pour laisser de la marge si Luc utilise d'autres tools en parallele.
export type SqueezeScanRow = FundingScreenerRow & {
  oiChangePercent4h: number | null;
  oiChangePercent1h: number | null;
  cvdRecentTrendPositive: boolean | null;
  cvdLastDeltaUsd: number | null;
  shortLiqUsd: number;
  longLiqUsd: number;
  shortLongLiqRatio: number | null;
  // Predicted funding rate (Coinalyze, gratuit) - null si symbole absent de Coinalyze.
  // Valeur brute telle que renvoyee par l'API (fraction, ex: -0.009464).
  // predictedFundingNegative = true signifie que la pression short se maintient
  // pour la prochaine periode ; false = le funding se retourne (signal negatif).
  predictedFundingRateRaw: number | null;
  predictedFundingNegative: boolean | null;
  qualifies: boolean;
  error?: string;
};

export async function buildSqueezeScan(
  candidates: FundingScreenerRow[],
  opts: { minOiChangePct?: number; minLiqRatio?: number; liqLookbackPeriods?: number; maxResults?: number } = {}
): Promise<SqueezeScanRow[]> {
  const minOiChangePct = opts.minOiChangePct ?? 5;
  const minLiqRatio = opts.minLiqRatio ?? 2;
  const lookback = opts.liqLookbackPeriods ?? 6;
  const maxResults = opts.maxResults ?? candidates.length;
  // Delai entre candidats couverts uniquement. Les coins sans donnees CoinGlass
  // sont sautes immediatement apres le check OI (1 appel), sans delai, ce qui
  // evite de gaspiller des slots et du temps sur des coins MEXC non couverts.
  const DELAY_MS = 2000;

  const results: SqueezeScanRow[] = [];
  let validCount = 0;

  for (let i = 0; i < candidates.length && validCount < maxResults; i++) {
    const c = candidates[i];

    // --- Etape 1 : check OI seul (1 appel). Si aucune donnee ou erreur, on saute ---
    // Petit delai entre chaque check OI pour ne pas bruler le quota sur 40 appels rapides.
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    let oiAll: { open_interest_change_percent_4h?: number; open_interest_change_percent_1h?: number } | undefined;
    try {
      const oiRaw = await CoinglassAPI.openInterestByExchange({ symbol: c.symbol }) as {
        data?: Array<{ exchange: string; open_interest_change_percent_4h?: number; open_interest_change_percent_1h?: number }>;
      };
      oiAll = oiRaw.data?.find((d) => d.exchange === "All");
    } catch {
      continue; // 429 ou coin invalide : on passe sans bloquer
    }

    if (!oiAll) continue; // Coin non couvert par CoinGlass Hobbyist

    validCount++;
    if (validCount > 1) await new Promise((r) => setTimeout(r, DELAY_MS));

    // --- Etape 2 : scan complet (CVD + liquidations + predicted) ---
    try {
      const oiChangePercent4h = oiAll.open_interest_change_percent_4h ?? null;
      const oiChangePercent1h = oiAll.open_interest_change_percent_1h ?? null;

      const [cvdRaw, liqRaw, predictedRaw] = await Promise.all([
        CoinglassAPI.aggregatedTakerBuySellVolume({ symbol: c.symbol, interval: "4h", limit: lookback }),
        CoinglassAPI.liquidationAggregated({ symbol: c.symbol, interval: "4h", limit: lookback }) as Promise<{
          data?: Array<{ aggregated_long_liquidation_usd?: number; aggregated_short_liquidation_usd?: number }>;
        }>,
        CoinalyzeAPI.predictedFundingRateCurrent({ symbol: c.symbol, exchange: c.exchange })
          .catch(() => null) as Promise<Array<{ value?: number }> | null>,
      ]);

      const cvdSeries = computeCvdSeries(
        (cvdRaw.data ?? []).map((d) => ({
          time: d.time,
          buyVol: Number(d.aggregated_buy_volume_usd),
          sellVol: Number(d.aggregated_sell_volume_usd),
        }))
      );
      const lastTwo = cvdSeries.slice(-2);
      const cvdLastDeltaUsd = cvdSeries.length ? cvdSeries[cvdSeries.length - 1].delta : null;
      const cvdRecentTrendPositive =
        lastTwo.length > 0 ? lastTwo.reduce((s, p) => s + p.delta, 0) > 0 : null;

      const liqData = (liqRaw as any).data ?? [];
      const shortLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.aggregated_short_liquidation_usd ?? 0), 0);
      const longLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.aggregated_long_liquidation_usd ?? 0), 0);
      const shortLongLiqRatio = longLiqUsd > 0 ? shortLiqUsd / longLiqUsd : shortLiqUsd > 0 ? null : null;

      const predictedFundingRateRaw =
        Array.isArray(predictedRaw) && predictedRaw.length > 0
          ? (predictedRaw[0].value ?? null)
          : null;
      const predictedFundingNegative =
        predictedFundingRateRaw !== null ? predictedFundingRateRaw < 0 : null;

      const qualifies =
        oiChangePercent4h !== null &&
        oiChangePercent4h >= minOiChangePct &&
        cvdRecentTrendPositive === true &&
        ((shortLongLiqRatio !== null && shortLongLiqRatio >= minLiqRatio) ||
          (longLiqUsd === 0 && shortLiqUsd > 0)) &&
        predictedFundingNegative !== false;

      results.push({
        ...c,
        oiChangePercent4h,
        oiChangePercent1h,
        cvdRecentTrendPositive,
        cvdLastDeltaUsd,
        shortLiqUsd,
        longLiqUsd,
        shortLongLiqRatio,
        predictedFundingRateRaw,
        predictedFundingNegative,
        qualifies,
      });
    } catch (err) {
      results.push({
        ...c,
        oiChangePercent4h: null,
        oiChangePercent1h: null,
        cvdRecentTrendPositive: null,
        cvdLastDeltaUsd: null,
        shortLiqUsd: 0,
        longLiqUsd: 0,
        shortLongLiqRatio: null,
        predictedFundingRateRaw: null,
        predictedFundingNegative: null,
        qualifies: false,
        error: err instanceof Error ? err.message : "erreur inconnue",
      });
    }
  }

  return results.sort((a, b) => Number(b.qualifies) - Number(a.qualifies));
}

// Scan surchauffe (setup short) : miroir inverse du squeeze scan.
// Cible les coins ou les longs sont surrepresentes et commencent a se faire
// liquider : funding tres positif + OI qui monte (longs s'accumulent) + CVD
// net vendeur (distribution) + liquidations dominees par les longs.
export type HeatScanRow = FundingScreenerRow & {
  oiChangePercent4h: number | null;
  oiChangePercent1h: number | null;
  cvdRecentTrendPositive: boolean | null;
  cvdLastDeltaUsd: number | null;
  shortLiqUsd: number;
  longLiqUsd: number;
  longShortLiqRatio: number | null;
  predictedFundingRateRaw: number | null;
  predictedFundingPositive: boolean | null;
  qualifies: boolean;
  error?: string;
};

export async function buildHeatScan(
  candidates: FundingScreenerRow[],
  opts: { minOiChangePct?: number; minLiqRatio?: number; liqLookbackPeriods?: number; maxResults?: number } = {}
): Promise<HeatScanRow[]> {
  const minOiChangePct = opts.minOiChangePct ?? 5;
  const minLiqRatio = opts.minLiqRatio ?? 2;
  const lookback = opts.liqLookbackPeriods ?? 6;
  const maxResults = opts.maxResults ?? candidates.length;
  const DELAY_MS = 2000;

  const results: HeatScanRow[] = [];
  let validCount = 0;

  for (let i = 0; i < candidates.length && validCount < maxResults; i++) {
    const c = candidates[i];

    // --- Etape 1 : check OI seul (1 appel). Si aucune donnee ou erreur, on saute ---
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    let oiAll: { open_interest_change_percent_4h?: number; open_interest_change_percent_1h?: number } | undefined;
    try {
      const oiRaw = await CoinglassAPI.openInterestByExchange({ symbol: c.symbol }) as {
        data?: Array<{ exchange: string; open_interest_change_percent_4h?: number; open_interest_change_percent_1h?: number }>;
      };
      oiAll = oiRaw.data?.find((d) => d.exchange === "All");
    } catch {
      continue;
    }

    if (!oiAll) continue;

    validCount++;
    if (validCount > 1) await new Promise((r) => setTimeout(r, DELAY_MS));

    // --- Etape 2 : scan complet (CVD + liquidations + predicted) ---
    try {
      const oiChangePercent4h = oiAll.open_interest_change_percent_4h ?? null;
      const oiChangePercent1h = oiAll.open_interest_change_percent_1h ?? null;

      const [cvdRaw, liqRaw, predictedRaw] = await Promise.all([
        CoinglassAPI.aggregatedTakerBuySellVolume({ symbol: c.symbol, interval: "4h", limit: lookback }),
        CoinglassAPI.liquidationAggregated({ symbol: c.symbol, interval: "4h", limit: lookback }) as Promise<{
          data?: Array<{ aggregated_long_liquidation_usd?: number; aggregated_short_liquidation_usd?: number }>;
        }>,
        CoinalyzeAPI.predictedFundingRateCurrent({ symbol: c.symbol, exchange: c.exchange })
          .catch(() => null) as Promise<Array<{ value?: number }> | null>,
      ]);

      const cvdSeries = computeCvdSeries(
        (cvdRaw.data ?? []).map((d) => ({
          time: d.time,
          buyVol: Number(d.aggregated_buy_volume_usd),
          sellVol: Number(d.aggregated_sell_volume_usd),
        }))
      );
      const lastTwo = cvdSeries.slice(-2);
      const cvdLastDeltaUsd = cvdSeries.length ? cvdSeries[cvdSeries.length - 1].delta : null;
      const cvdRecentTrendPositive =
        lastTwo.length > 0 ? lastTwo.reduce((s, p) => s + p.delta, 0) > 0 : null;

      const liqData = (liqRaw as any).data ?? [];
      const shortLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.aggregated_short_liquidation_usd ?? 0), 0);
      const longLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.aggregated_long_liquidation_usd ?? 0), 0);
      // Ratio inverse : longs liquidés / shorts liquidés
      const longShortLiqRatio = shortLiqUsd > 0 ? longLiqUsd / shortLiqUsd : longLiqUsd > 0 ? null : null;

      const predictedFundingRateRaw =
        Array.isArray(predictedRaw) && predictedRaw.length > 0
          ? (predictedRaw[0].value ?? null)
          : null;
      const predictedFundingPositive =
        predictedFundingRateRaw !== null ? predictedFundingRateRaw > 0 : null;

      const qualifies =
        oiChangePercent4h !== null &&
        oiChangePercent4h >= minOiChangePct &&
        cvdRecentTrendPositive === false &&
        ((longShortLiqRatio !== null && longShortLiqRatio >= minLiqRatio) ||
          (shortLiqUsd === 0 && longLiqUsd > 0)) &&
        predictedFundingPositive !== false;

      results.push({
        ...c,
        oiChangePercent4h,
        oiChangePercent1h,
        cvdRecentTrendPositive,
        cvdLastDeltaUsd,
        shortLiqUsd,
        longLiqUsd,
        longShortLiqRatio,
        predictedFundingRateRaw,
        predictedFundingPositive,
        qualifies,
      });
    } catch (err) {
      results.push({
        ...c,
        oiChangePercent4h: null,
        oiChangePercent1h: null,
        cvdRecentTrendPositive: null,
        cvdLastDeltaUsd: null,
        shortLiqUsd: 0,
        longLiqUsd: 0,
        longShortLiqRatio: null,
        predictedFundingRateRaw: null,
        predictedFundingPositive: null,
        qualifies: false,
        error: err instanceof Error ? err.message : "erreur inconnue",
      });
    }
  }

  return results.sort((a, b) => Number(b.qualifies) - Number(a.qualifies));
}
