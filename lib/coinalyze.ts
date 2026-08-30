// Client pour l'API Coinalyze v1 - gratuite, complementaire a CoinGlass.
// Doc officielle : https://api.coinalyze.net/v1/doc/
//
// Particularite Coinalyze : chaque marche a un symbole du type "ZKCUSDT_PERP.A"
// ou le suffixe (.A, .6, ...) encode l'exchange. Ces codes ne sont pas documentes
// de facon stable dans le temps, donc on les resout dynamiquement via
// /exchanges + /future-markets plutot que de les coder en dur - une erreur de
// mapping coderait en dur donnerait silencieusement les donnees du mauvais
// exchange, ce qui est pire qu'un appel API de plus.

const BASE_URL = "https://api.coinalyze.net/v1";

export class CoinalyzeError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function apiKey(): string {
  const key = process.env.COINALYZE_API_KEY;
  if (!key) {
    throw new Error(
      "COINALYZE_API_KEY manquante. Ajoute-la dans les variables d'environnement Vercel (jamais cote client)."
    );
  }
  return key;
}

async function coinalyzeGet<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(path, BASE_URL);
  url.searchParams.set("api_key", apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new CoinalyzeError(`Coinalyze API erreur sur ${path}`, res.status, json);
  }

  return json as T;
}

// --- Resolution dynamique exchange + symbole -------------------------------

type ExchangeInfo = { name: string; code: string };
type FutureMarket = {
  symbol: string;
  exchange: string; // = le code exchange (ex "A")
  symbol_on_exchange: string;
  base_asset: string;
  quote_asset: string;
  is_perpetual: boolean;
  margined: "STABLE" | "COIN";
};

// Cache memoire simple (duree de vie d'une instance serverless chaude).
// Pas critique si elle est froide a chaque fois : ~2 appels de plus, sous la
// limite de 40/min largement.
let exchangesCache: { data: ExchangeInfo[]; fetchedAt: number } | null = null;
let marketsCache: { data: FutureMarket[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

async function getExchanges(): Promise<ExchangeInfo[]> {
  if (exchangesCache && Date.now() - exchangesCache.fetchedAt < CACHE_TTL_MS) {
    return exchangesCache.data;
  }
  const data = await coinalyzeGet<ExchangeInfo[]>("/exchanges");
  exchangesCache = { data, fetchedAt: Date.now() };
  return data;
}

async function getFutureMarkets(): Promise<FutureMarket[]> {
  if (marketsCache && Date.now() - marketsCache.fetchedAt < CACHE_TTL_MS) {
    return marketsCache.data;
  }
  const data = await coinalyzeGet<FutureMarket[]>("/future-markets");
  marketsCache = { data, fetchedAt: Date.now() };
  return data;
}

// "Binance" -> code exchange Coinalyze (ex "A"). Recherche insensible a la casse,
// tolere les variantes ("Binance Futures", etc.) par sous-chaine.
async function resolveExchangeCode(exchangeName: string): Promise<string> {
  const exchanges = await getExchanges();
  const target = exchangeName.trim().toLowerCase();
  const exact = exchanges.find((e) => e.name.toLowerCase() === target);
  if (exact) return exact.code;
  const partial = exchanges.find(
    (e) => e.name.toLowerCase().includes(target) || target.includes(e.name.toLowerCase())
  );
  if (partial) return partial.code;
  throw new Error(
    `Exchange "${exchangeName}" introuvable sur Coinalyze. Exchanges disponibles : ${exchanges
      .map((e) => e.name)
      .join(", ")}`
  );
}

// "ZKC" + "Binance" -> "ZKCUSDT_PERP.A" (priorite au perpetuel USDT-margine,
// le plus liquide et celui utilise par Luc).
export async function resolveSymbol(baseAsset: string, exchangeName: string): Promise<string> {
  const code = await resolveExchangeCode(exchangeName);
  const markets = await getFutureMarkets();
  const base = baseAsset.trim().toUpperCase();

  const candidates = markets.filter(
    (m) => m.exchange === code && m.base_asset.toUpperCase() === base && m.is_perpetual
  );

  if (candidates.length === 0) {
    throw new Error(
      `Aucun marche perpetuel pour ${base} sur ${exchangeName} (code ${code}) trouve sur Coinalyze.`
    );
  }

  const stableMargined = candidates.find((m) => m.margined === "STABLE");
  return (stableMargined ?? candidates[0]).symbol;
}

// --- Intervalle : mappe le style CoinGlass (deja utilise dans ce serveur) ---
// vers le style Coinalyze.
const INTERVAL_MAP: Record<string, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1hour",
  "2h": "2hour",
  "4h": "4hour",
  "6h": "6hour",
  "12h": "12hour",
  "1d": "daily",
};

const INTERVAL_SECONDS: Record<string, number> = {
  "1min": 60,
  "5min": 300,
  "15min": 900,
  "30min": 1800,
  "1hour": 3600,
  "2hour": 7200,
  "4hour": 14400,
  "6hour": 21600,
  "12hour": 43200,
  daily: 86400,
};

function toCoinalyzeInterval(cgStyle?: string): string {
  const s = cgStyle ?? "1h";
  const mapped = INTERVAL_MAP[s] ?? s;
  if (!(mapped in INTERVAL_SECONDS)) {
    throw new Error(
      `Intervalle "${s}" non supporte par Coinalyze. Valeurs possibles : ${Object.keys(
        INTERVAL_MAP
      ).join(", ")}`
    );
  }
  return mapped;
}

// Calcule from/to (secondes unix) a partir d'un nombre de points souhaite,
// pour matcher l'ergonomie "limit" deja utilisee dans les tools CoinGlass.
function timeRangeFor(interval: string, limit: number): { from: number; to: number } {
  const to = Math.floor(Date.now() / 1000);
  const seconds = INTERVAL_SECONDS[interval];
  const from = to - seconds * limit;
  return { from, to };
}

// --- Wrappers haut niveau, memes parametres que les tools CoinGlass --------

const DEFAULT_EXCHANGE = "Binance";

export const CoinalyzeAPI = {
  fundingRateCurrent: async (p: { symbol: string; exchange?: string }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    return coinalyzeGet("/funding-rate", { symbols: sym });
  },

  openInterestCurrent: async (p: { symbol: string; exchange?: string }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    return coinalyzeGet("/open-interest", { symbols: sym, convert_to_usd: "true" });
  },

  predictedFundingRateCurrent: async (p: { symbol: string; exchange?: string }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    return coinalyzeGet("/predicted-funding-rate", { symbols: sym });
  },

  fundingRateHistory: async (p: {
    symbol: string;
    exchange?: string;
    interval?: string;
    limit?: number;
  }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    const interval = toCoinalyzeInterval(p.interval);
    const { from, to } = timeRangeFor(interval, p.limit ?? 50);
    return coinalyzeGet("/funding-rate-history", { symbols: sym, interval, from, to });
  },

  openInterestHistory: async (p: {
    symbol: string;
    exchange?: string;
    interval?: string;
    limit?: number;
  }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    const interval = toCoinalyzeInterval(p.interval);
    const { from, to } = timeRangeFor(interval, p.limit ?? 50);
    return coinalyzeGet("/open-interest-history", {
      symbols: sym,
      interval,
      from,
      to,
      convert_to_usd: "true",
    });
  },

  liquidationHistory: async (p: {
    symbol: string;
    exchange?: string;
    interval?: string;
    limit?: number;
  }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    const interval = toCoinalyzeInterval(p.interval);
    const { from, to } = timeRangeFor(interval, p.limit ?? 50);
    return coinalyzeGet("/liquidation-history", {
      symbols: sym,
      interval,
      from,
      to,
      convert_to_usd: "true",
    });
  },

  longShortRatioHistory: async (p: {
    symbol: string;
    exchange?: string;
    interval?: string;
    limit?: number;
  }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    const interval = toCoinalyzeInterval(p.interval);
    const { from, to } = timeRangeFor(interval, p.limit ?? 50);
    return coinalyzeGet("/long-short-ratio-history", { symbols: sym, interval, from, to });
  },

  // Precieux : donne le PRIX (OHLCV), ce que CoinGlass ne fournit pas sur le
  // plan Hobbyist en dessous de 4h. Comble le trou signale dans le workflow
  // (Luc envoie un screenshot du 5m car l'API CoinGlass ne le couvre pas).
  ohlcvHistory: async (p: {
    symbol: string;
    exchange?: string;
    interval?: string;
    limit?: number;
  }) => {
    const sym = await resolveSymbol(p.symbol, p.exchange ?? DEFAULT_EXCHANGE);
    const interval = toCoinalyzeInterval(p.interval);
    const { from, to } = timeRangeFor(interval, p.limit ?? 50);
    return coinalyzeGet("/ohlcv-history", { symbols: sym, interval, from, to });
  },
};
