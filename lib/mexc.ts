// Client pour l'API publique MEXC Futures. Aucune cle requise pour les
// endpoints "Market endpoints". Doc : https://www.mexc.com/api-docs/futures/market-endpoints
//
// Pas de screener bulk cote MEXC (le funding rate se recupere symbole par
// symbole, contrairement a Binance) - utilise ce client pour recouper UN
// symbole deja repere via get_funding_screener, pas pour scanner tout le marche.

const BASE_URL = "https://api.mexc.com";

export class MexcError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function mexcGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL).toString(), { cache: "no-store" });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && typeof json === "object" && "success" in json && json.success === false)) {
    throw new MexcError(`MEXC API erreur sur ${path}`, res.status, json);
  }
  return json as T;
}

function toMexcPair(symbol: string): string {
  const s = symbol.toUpperCase().trim();
  if (s.includes("_")) return s;
  const base = s.replace(/(USDT|USDC|USD)$/, "");
  return `${base}_USDT`;
}

export const MexcAPI = {
  fundingRate: (p: { symbol: string }) =>
    mexcGet(`/api/v1/contract/funding_rate/${toMexcPair(p.symbol)}`),
};
