// Client pour l'API publique Binance Futures (USDS-M). AUCUNE cle API requise -
// endpoints "market data" ouverts, contrairement a Coinalyze qui exige un compte.
// Doc : https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data

const BASE_URL = "https://fapi.binance.com";

export class BinanceError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function binanceGet<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new BinanceError(`Binance API erreur sur ${path}`, res.status, json);
  }
  return json as T;
}

type PremiumIndexEntry = {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
};

type FundingInfoEntry = {
  symbol: string;
  fundingIntervalHours: number;
};

type Ticker24hEntry = {
  symbol: string;
  quoteVolume: string;
};

export type ScreenerRow = {
  symbol: string;
  fundingRatePerInterval: number; // taux tel qu'affiche, pour l'intervalle reel
  fundingIntervalHours: number; // 8 par defaut, sauf ajustement liste dans fundingInfo
  fundingRateHourly: number; // normalise a l'heure - c'est CE chiffre qu'il faut comparer entre symboles
  markPrice: number;
  quoteVolume24hUsd: number;
  nextFundingTime: number;
};

async function buildScreenerRows(): Promise<ScreenerRow[]> {
  const [premium, fundingInfo, tickers] = await Promise.all([
    binanceGet<PremiumIndexEntry[]>("/fapi/v1/premiumIndex"),
    binanceGet<FundingInfoEntry[]>("/fapi/v1/fundingInfo"),
    binanceGet<Ticker24hEntry[]>("/fapi/v1/ticker/24hr"),
  ]);

  // Seuls les symboles a intervalle NON standard apparaissent ici (Binance
  // n'expose pas les 8h par defaut) - d'ou le fallback a 8 plus bas.
  const intervalMap = new Map<string, number>();
  for (const f of fundingInfo) intervalMap.set(f.symbol, f.fundingIntervalHours);

  const volumeMap = new Map<string, number>();
  for (const t of tickers) volumeMap.set(t.symbol, Number(t.quoteVolume) || 0);

  return premium
    .filter((p) => p.symbol.endsWith("USDT") && p.lastFundingRate !== "")
    .map((p) => {
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
      };
    });
}

export const BinanceAPI = {
  // Le coeur de l'ajout : reproduit et ameliore le tableau de bord CoinGlass
  // ("Taux financement" trie par extremes) que Luc envoyait en capture -
  // mais normalise a l'heure, ce qui evite de classer ZKC (funding 1h) en
  // dessous de SKR (funding 4h) alors qu'a l'heure ZKC paie plus.
  fundingScreener: async (p: { limit?: number; minVolumeUsd?: number }) => {
    const rows = await buildScreenerRows();
    const minVol = p.minVolumeUsd ?? 3_000_000; // filtre le bruit illiquide
    const filtered = rows.filter((r) => r.quoteVolume24hUsd >= minVol);
    const limit = p.limit ?? 15;

    const mostNegative = [...filtered]
      .sort((a, b) => a.fundingRateHourly - b.fundingRateHourly)
      .slice(0, limit);
    const mostPositive = [...filtered]
      .sort((a, b) => b.fundingRateHourly - a.fundingRateHourly)
      .slice(0, limit);

    return { mostNegativeHourly: mostNegative, mostPositiveHourly: mostPositive };
  },

  // Lookup simple pour un symbole deja identifie (recoupement).
  fundingRate: async (p: { symbol: string }) => {
    const sym = toBinancePair(p.symbol);
    return binanceGet<PremiumIndexEntry>("/fapi/v1/premiumIndex", { symbol: sym });
  },

  openInterest: async (p: { symbol: string }) => {
    const sym = toBinancePair(p.symbol);
    return binanceGet("/fapi/v1/openInterest", { symbol: sym });
  },
};

function toBinancePair(symbol: string): string {
  const s = symbol.toUpperCase().trim();
  return /(USDT|USDC|USD)$/.test(s) ? s : `${s}USDT`;
}
