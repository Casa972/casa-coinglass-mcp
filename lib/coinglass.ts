// lib/coinglass.ts — Redirection vers sources gratuites (Binance/MEXC/Hyperliquid/Coinalyze)
// Tous les appels CoinGlass cassés (plan Hobbyist → 401) sont remplacés.
// Les signatures restent identiques pour ne pas modifier route.ts.

import { BinanceAPI, BinanceGeoBlockError, type ScreenerRow as BinanceScreenerRow } from "@/lib/binance";
import { MexcAPI, type MexcScreenerRow } from "@/lib/mexc";
import { CoinalyzeAPI } from "@/lib/coinalyze";

export class CoinglassError extends Error {
  status: number; body: unknown;
  constructor(msg: string, status: number, body: unknown) {
    super(msg); this.status = status; this.body = body;
  }
}

export function toPair(symbol: string): string {
  const s = symbol.toUpperCase().trim();
  return /(USDT|USDC|USD)$/.test(s) ? s : `${s}USDT`;
}
export function toCoin(symbol: string): string {
  return symbol.toUpperCase().trim().replace(/(USDT|USDC|USD)$/, "");
}

// Format CoinGlass émulé pour compat avec buildFundingScreener
type CGFundingEntry = {
  symbol: string;
  quoteVolume24hUsd?: number; // max sur tous les exchanges pour ce symbole
  stablecoin_margin_list: Array<{ exchange: string; funding_rate: number; funding_rate_interval: number }>;
};

export const CoinglassAPI = {
  // OI historique → Binance /futures/data/openInterestHist
  openInterestHistory: (p: { symbol: string; interval?: string; limit?: number; exchange?: string }) =>
    BinanceAPI.openInterestHistory({ symbol: p.symbol, interval: p.interval, limit: p.limit }),

  // OI actuel par exchange → Binance + MEXC + change %
  openInterestByExchange: async (p: { symbol: string }) => {
    const sym = toPair(p.symbol);
    const [oiChange, mexcFunding] = await Promise.allSettled([
      BinanceAPI.openInterestWithChange({ symbol: sym }),
      MexcAPI.fundingRate({ symbol: sym }),
    ]);

    const binanceOI = oiChange.status === "fulfilled" ? oiChange.value : null;
    const mexcOI = mexcFunding.status === "fulfilled" ? (mexcFunding.value as any)?.data : null;

    const rows = [];

    if (binanceOI) {
      rows.push({
        exchange: "Binance",
        open_interest_usd: binanceOI.open_interest_usd ?? 0,
        open_interest_change_percent_4h: binanceOI.open_interest_change_percent_4h,
        open_interest_change_percent_1h: binanceOI.open_interest_change_percent_1h,
      });
    }
    if (mexcOI) {
      rows.push({
        exchange: "MEXC",
        open_interest_usd: null,
        idxPrice: mexcOI.idxPrice,
        fundingRate: mexcOI.fundingRate,
      });
    }

    // Ligne "All" agrégée (change 4h de Binance comme proxy)
    return {
      data: [
        {
          exchange: "All",
          open_interest_usd: binanceOI?.open_interest_usd ?? null,
          open_interest_change_percent_4h: binanceOI?.open_interest_change_percent_4h ?? null,
          open_interest_change_percent_1h: binanceOI?.open_interest_change_percent_1h ?? null,
        },
        ...rows,
      ],
    };
  },

  // Historique funding → Binance /fapi/v1/fundingRate (événements réels, pas intervalles arbitraires)
  fundingRateHistory: (p: { symbol: string; interval?: string; limit?: number; exchange?: string }) =>
    BinanceAPI.fundingRateHistory({ symbol: p.symbol, limit: p.limit }),

  // Tous les symboles (Binance + MEXC) au format CoinGlass pour buildFundingScreener
  fundingRateByExchange: async (): Promise<{ data: CGFundingEntry[] }> => {
    const [binanceRows, mexcResult] = await Promise.allSettled([
      BinanceAPI.allRows(0), // 0 = pas de filtre volume ici, buildFundingScreener filtrera
      MexcAPI.fundingScreener({ minVolumeUsd: 0 }),
    ]);

    const symbolMap = new Map<string, CGFundingEntry>();

    const upsert = (sym: string, exchange: string, fundingRate: number, intervalHours: number, vol?: number) => {
      const coin = sym.replace(/USDT$/i, "").toUpperCase();
      if (!symbolMap.has(coin)) {
        symbolMap.set(coin, { symbol: coin, quoteVolume24hUsd: vol ?? 0, stablecoin_margin_list: [] });
      } else if (vol !== undefined) {
        const entry = symbolMap.get(coin)!;
        entry.quoteVolume24hUsd = Math.max(entry.quoteVolume24hUsd ?? 0, vol);
      }
      // funding_rate en % (CG convention) : Binance stocke en décimal → *100 ; MEXC aussi
      symbolMap.get(coin)!.stablecoin_margin_list.push({
        exchange,
        funding_rate: fundingRate * 100,  // décimal → %
        funding_rate_interval: intervalHours,
      });
    };

    if (binanceRows.status === "fulfilled") {
      const source = binanceRows.value[0]?.source ?? "binance";
      const exchange = source === "hyperliquid" ? "Hyperliquid" : "Binance";
      for (const r of binanceRows.value) {
        upsert(r.symbol, exchange, r.fundingRatePerInterval, r.fundingIntervalHours, r.quoteVolume24hUsd);
      }
    }

    if (mexcResult.status === "fulfilled") {
      const allMexc = [
        ...mexcResult.value.mostNegativeHourly,
        ...mexcResult.value.mostPositiveHourly,
      ];
      const seen = new Set<string>();
      for (const r of allMexc) {
        if (seen.has(r.symbol)) continue;
        seen.add(r.symbol);
        upsert(r.symbol, "MEXC", r.fundingRatePerInterval, r.fundingIntervalHours, r.quoteVolume24hUsd);
      }
    }

    return { data: [...symbolMap.values()] };
  },

  // CVD → Binance klines avec taker buy/sell volumes
  aggregatedTakerBuySellVolume: async (p: { symbol: string; interval?: string; limit?: number; exchangeList?: string }) => {
    const cvd = await BinanceAPI.cvdFromKlines({ symbol: p.symbol, interval: p.interval, limit: p.limit });
    return {
      data: cvd.map(c => ({
        time: c.time,
        aggregated_buy_volume_usd: c.buyVol,
        aggregated_sell_volume_usd: c.sellVol,
      })),
    };
  },

  // Long/Short global → Binance /futures/data/globalLongShortAccountRatio
  globalLongShortRatio: async (p: { symbol: string; interval?: string; limit?: number; exchange?: string }) => {
    const data = await BinanceAPI.longShortRatio({ symbol: p.symbol, type: "global", interval: p.interval, limit: p.limit });
    return { data };
  },

  // Long/Short top traders → Binance /futures/data/topLongShortPositionRatio
  topTraderLongShortRatio: async (p: { symbol: string; interval?: string; limit?: number; exchange?: string }) => {
    const data = await BinanceAPI.longShortRatio({ symbol: p.symbol, type: "topPosition", interval: p.interval, limit: p.limit });
    return { data };
  },

  // Liquidations → Coinalyze (seule source gratuite avec historique ; nécessite COINALYZE_API_KEY)
  liquidationAggregated: async (p: { symbol: string; interval?: string; limit?: number; exchangeList?: string }) => {
    try {
      const data = await CoinalyzeAPI.liquidationHistory({
        symbol: toCoin(p.symbol),
        interval: p.interval,
        limit: p.limit,
      });
      return { data };
    } catch {
      throw new Error(
        "Liquidations nécessitent COINALYZE_API_KEY dans Vercel. " +
        "Binance forceOrders exige une signature. " +
        "Ajoutez la clé dans Settings → Environment Variables."
      );
    }
  },
};

// ─── SCREENER ─────────────────────────────────────────────────────────────────

export type FundingScreenerRow = {
  symbol: string; exchange: string;
  fundingRatePerInterval: number; intervalHours: number; fundingRateHourly: number;
};

// Tickers non-crypto connus sur MEXC (matières premières, ETF US) — source de faux positifs
// dans get_squeeze_scan / get_heat_scan car leurs funding rates sont extrêmes (aucune liquidité crypto).
const NON_CRYPTO_SYMBOLS = new Set(["UKOIL", "USOIL", "USO", "NGAS", "IBB", "SOXX"]);

export function buildFundingScreener(
  raw: { data?: Array<{ symbol: string; quoteVolume24hUsd?: number; stablecoin_margin_list?: Array<{ exchange: string; funding_rate?: number; funding_rate_interval?: number }> }> },
  opts: { limit?: number; exchanges?: string[]; minVolumeUsd?: number } = {}
) {
  const exchanges = opts.exchanges ?? ["Binance", "MEXC", "Hyperliquid"];
  const limit = opts.limit ?? 15;
  const minVolumeUsd = opts.minVolumeUsd ?? 20_000_000;

  const rows: FundingScreenerRow[] = [];
  for (const entry of raw.data ?? []) {
    const sym = entry.symbol.toUpperCase();
    // Exclure les produits non-crypto (matières premières, ETF) remontés par MEXC
    if (sym.endsWith("STOCK")) continue;
    if (NON_CRYPTO_SYMBOLS.has(sym)) continue;
    // Filtre volume 24h (évite les perps MEXC illiquides avec funding extrême artificiel)
    if ((entry.quoteVolume24hUsd ?? 0) < minVolumeUsd) continue;
    for (const ex of entry.stablecoin_margin_list ?? []) {
      if (!exchanges.some(e => ex.exchange.toLowerCase().includes(e.toLowerCase()))) continue;
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

  // Garde la ligne la plus extrême par symbole
  const worstBySymbol = new Map<string, FundingScreenerRow>();
  const bestBySymbol = new Map<string, FundingScreenerRow>();
  for (const r of rows) {
    const w = worstBySymbol.get(r.symbol);
    if (!w || r.fundingRateHourly < w.fundingRateHourly) worstBySymbol.set(r.symbol, r);
    const b = bestBySymbol.get(r.symbol);
    if (!b || r.fundingRateHourly > b.fundingRateHourly) bestBySymbol.set(r.symbol, r);
  }

  const mostNegativeHourly = [...worstBySymbol.values()]
    .sort((a, b) => a.fundingRateHourly - b.fundingRateHourly).slice(0, limit);
  const mostPositiveHourly = [...bestBySymbol.values()]
    .sort((a, b) => b.fundingRateHourly - a.fundingRateHourly).slice(0, limit);

  return { mostNegativeHourly, mostPositiveHourly };
}

export function computeCvdSeries(series: Array<{ time: number; buyVol: number; sellVol: number }>) {
  let cumulative = 0;
  return series.map(point => {
    const delta = point.buyVol - point.sellVol;
    cumulative += delta;
    return { time: point.time, delta, cvd: cumulative };
  });
}

// ─── SQUEEZE SCAN ─────────────────────────────────────────────────────────────

export type SqueezeScanRow = FundingScreenerRow & {
  oiChangePercent4h: number | null; oiChangePercent1h: number | null;
  cvdRecentTrendPositive: boolean | null; cvdLastDeltaUsd: number | null;
  shortLiqUsd: number; longLiqUsd: number; shortLongLiqRatio: number | null;
  predictedFundingRateRaw: number | null; predictedFundingNegative: boolean | null;
  qualifies: boolean; error?: string;
};

export async function buildSqueezeScan(
  candidates: FundingScreenerRow[],
  opts: { minOiChangePct?: number; minLiqRatio?: number; liqLookbackPeriods?: number; maxResults?: number } = {}
): Promise<SqueezeScanRow[]> {
  const minOiChangePct = opts.minOiChangePct ?? 5;
  const minLiqRatio = opts.minLiqRatio ?? 2;
  const lookback = opts.liqLookbackPeriods ?? 6;
  const maxResults = opts.maxResults ?? candidates.length;
  const DELAY_MS = 500;

  const results: SqueezeScanRow[] = [];
  let validCount = 0;

  for (let i = 0; i < candidates.length && validCount < maxResults; i++) {
    const c = candidates[i];
    if (i > 0) await new Promise(r => setTimeout(r, DELAY_MS));

    try {
      const sym = toPair(c.symbol);

      // OI change (Binance)
      const oiData = await BinanceAPI.openInterestWithChange({ symbol: sym }).catch(() => null);
      const oiChangePercent4h = oiData?.open_interest_change_percent_4h ?? null;
      const oiChangePercent1h = oiData?.open_interest_change_percent_1h ?? null;

      validCount++;

      // CVD (Binance klines taker volumes)
      const cvdData = await BinanceAPI.cvdFromKlines({ symbol: sym, interval: "4h", limit: lookback }).catch(() => []);
      const lastTwo = cvdData.slice(-2);
      const cvdLastDeltaUsd = cvdData.length ? cvdData[cvdData.length - 1].delta : null;
      const cvdRecentTrendPositive = lastTwo.length > 0 ? lastTwo.reduce((s, p) => s + p.delta, 0) > 0 : null;

      // Liquidations (Coinalyze — optionnel, passe si clé absente)
      let shortLiqUsd = 0, longLiqUsd = 0, shortLongLiqRatio: number | null = null;
      try {
        const liqRaw = await CoinalyzeAPI.liquidationHistory({ symbol: toCoin(sym), interval: "4h", limit: lookback }) as any;
        const liqData: any[] = Array.isArray(liqRaw) ? liqRaw : (liqRaw?.data ?? []);
        shortLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.short ?? d.s ?? 0), 0);
        longLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.long ?? d.l ?? 0), 0);
        shortLongLiqRatio = longLiqUsd > 0 ? shortLiqUsd / longLiqUsd : shortLiqUsd > 0 ? null : null;
      } catch { /* pas de clé Coinalyze — criterion ignoré */ }

      // Predicted funding (Coinalyze — optionnel)
      let predictedFundingRateRaw: number | null = null, predictedFundingNegative: boolean | null = null;
      try {
        const pred = await CoinalyzeAPI.predictedFundingRateCurrent({ symbol: toCoin(sym), exchange: c.exchange }) as any;
        predictedFundingRateRaw = Array.isArray(pred) && pred.length > 0 ? (pred[0].value ?? null) : null;
        predictedFundingNegative = predictedFundingRateRaw !== null ? predictedFundingRateRaw < 0 : null;
      } catch { /* pas de clé */ }

      // Qualification
      const oiOk = oiChangePercent4h !== null && oiChangePercent4h >= minOiChangePct;
      const cvdOk = cvdRecentTrendPositive === true;
      const liqOk = shortLongLiqRatio === null /* pas de données = on passe */ ||
        shortLongLiqRatio >= minLiqRatio || (longLiqUsd === 0 && shortLiqUsd > 0);
      const predOk = predictedFundingNegative !== false; // null = on passe

      const qualifies = oiOk && cvdOk && liqOk && predOk;

      results.push({
        ...c,
        oiChangePercent4h, oiChangePercent1h,
        cvdRecentTrendPositive, cvdLastDeltaUsd,
        shortLiqUsd, longLiqUsd, shortLongLiqRatio,
        predictedFundingRateRaw, predictedFundingNegative,
        qualifies,
      });
    } catch (err) {
      results.push({
        ...c,
        oiChangePercent4h: null, oiChangePercent1h: null,
        cvdRecentTrendPositive: null, cvdLastDeltaUsd: null,
        shortLiqUsd: 0, longLiqUsd: 0, shortLongLiqRatio: null,
        predictedFundingRateRaw: null, predictedFundingNegative: null,
        qualifies: false,
        error: err instanceof Error ? err.message : "erreur inconnue",
      });
    }
  }

  return results.sort((a, b) => Number(b.qualifies) - Number(a.qualifies));
}

// ─── HEAT SCAN ────────────────────────────────────────────────────────────────

export type HeatScanRow = FundingScreenerRow & {
  oiChangePercent4h: number | null; oiChangePercent1h: number | null;
  cvdRecentTrendPositive: boolean | null; cvdLastDeltaUsd: number | null;
  shortLiqUsd: number; longLiqUsd: number; longShortLiqRatio: number | null;
  predictedFundingRateRaw: number | null; predictedFundingPositive: boolean | null;
  qualifies: boolean; error?: string;
};

export async function buildHeatScan(
  candidates: FundingScreenerRow[],
  opts: { minOiChangePct?: number; minLiqRatio?: number; liqLookbackPeriods?: number; maxResults?: number } = {}
): Promise<HeatScanRow[]> {
  const minOiChangePct = opts.minOiChangePct ?? 5;
  const minLiqRatio = opts.minLiqRatio ?? 2;
  const lookback = opts.liqLookbackPeriods ?? 6;
  const maxResults = opts.maxResults ?? candidates.length;
  const DELAY_MS = 500;

  const results: HeatScanRow[] = [];
  let validCount = 0;

  for (let i = 0; i < candidates.length && validCount < maxResults; i++) {
    const c = candidates[i];
    if (i > 0) await new Promise(r => setTimeout(r, DELAY_MS));

    try {
      const sym = toPair(c.symbol);

      const oiData = await BinanceAPI.openInterestWithChange({ symbol: sym }).catch(() => null);
      const oiChangePercent4h = oiData?.open_interest_change_percent_4h ?? null;
      const oiChangePercent1h = oiData?.open_interest_change_percent_1h ?? null;

      validCount++;

      const cvdData = await BinanceAPI.cvdFromKlines({ symbol: sym, interval: "4h", limit: lookback }).catch(() => []);
      const lastTwo = cvdData.slice(-2);
      const cvdLastDeltaUsd = cvdData.length ? cvdData[cvdData.length - 1].delta : null;
      const cvdRecentTrendPositive = lastTwo.length > 0 ? lastTwo.reduce((s, p) => s + p.delta, 0) > 0 : null;

      let shortLiqUsd = 0, longLiqUsd = 0, longShortLiqRatio: number | null = null;
      try {
        const liqRaw = await CoinalyzeAPI.liquidationHistory({ symbol: toCoin(sym), interval: "4h", limit: lookback }) as any;
        const liqData: any[] = Array.isArray(liqRaw) ? liqRaw : (liqRaw?.data ?? []);
        shortLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.short ?? d.s ?? 0), 0);
        longLiqUsd = liqData.reduce((s: number, d: any) => s + Number(d.long ?? d.l ?? 0), 0);
        longShortLiqRatio = shortLiqUsd > 0 ? longLiqUsd / shortLiqUsd : longLiqUsd > 0 ? null : null;
      } catch { /* clé absente */ }

      let predictedFundingRateRaw: number | null = null, predictedFundingPositive: boolean | null = null;
      try {
        const pred = await CoinalyzeAPI.predictedFundingRateCurrent({ symbol: toCoin(sym), exchange: c.exchange }) as any;
        predictedFundingRateRaw = Array.isArray(pred) && pred.length > 0 ? (pred[0].value ?? null) : null;
        predictedFundingPositive = predictedFundingRateRaw !== null ? predictedFundingRateRaw > 0 : null;
      } catch { /* clé absente */ }

      const oiOk = oiChangePercent4h !== null && oiChangePercent4h >= minOiChangePct;
      const cvdOk = cvdRecentTrendPositive === false;
      const liqOk = longShortLiqRatio === null || longShortLiqRatio >= minLiqRatio || (shortLiqUsd === 0 && longLiqUsd > 0);
      const predOk = predictedFundingPositive !== false;

      const qualifies = oiOk && cvdOk && liqOk && predOk;

      results.push({
        ...c,
        oiChangePercent4h, oiChangePercent1h,
        cvdRecentTrendPositive, cvdLastDeltaUsd,
        shortLiqUsd, longLiqUsd, longShortLiqRatio,
        predictedFundingRateRaw, predictedFundingPositive,
        qualifies,
      });
    } catch (err) {
      results.push({
        ...c,
        oiChangePercent4h: null, oiChangePercent1h: null,
        cvdRecentTrendPositive: null, cvdLastDeltaUsd: null,
        shortLiqUsd: 0, longLiqUsd: 0, longShortLiqRatio: null,
        predictedFundingRateRaw: null, predictedFundingPositive: null,
        qualifies: false,
        error: err instanceof Error ? err.message : "erreur inconnue",
      });
    }
  }

  return results.sort((a, b) => Number(b.qualifies) - Number(a.qualifies));
}
