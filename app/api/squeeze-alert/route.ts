// Endpoint REST simple (PAS le protocole MCP) pour que le script Python du
// VPS puisse interroger le scan directement en HTTP/JSON, sans parler MCP.
// Reutilise exactement la meme logique que le tool get_squeeze_scan.
//
// Protege par un token partage (query param ?token=...) pour eviter que
// n'importe qui trouvant l'URL declenche des scans qui consomment le quota
// CoinGlass (30 req/min sur le plan Hobbyist).

import { CoinglassAPI, buildFundingScreener, buildSqueezeScan } from "@/lib/coinglass";

export const maxDuration = 300;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expected = process.env.ALERT_SECRET;

  if (!expected) {
    return Response.json(
      { error: "ALERT_SECRET manquant cote serveur. Ajoute-le dans les variables d'environnement Vercel." },
      { status: 500 }
    );
  }
  if (!token || token !== expected) {
    return Response.json({ error: "Token invalide ou manquant." }, { status: 401 });
  }

  const candidateCount = Number(url.searchParams.get("candidateCount") ?? 8);
  const minOiChangePct = Number(url.searchParams.get("minOiChangePct") ?? 5);
  const minLiqRatio = Number(url.searchParams.get("minLiqRatio") ?? 2);

  try {
    const fundingRaw = await CoinglassAPI.fundingRateByExchange();
    const screener = buildFundingScreener(fundingRaw, {
      limit: candidateCount,
      exchanges: ["Binance", "MEXC"],
    });
    const scan = await buildSqueezeScan(screener.mostNegativeHourly, {
      minOiChangePct,
      minLiqRatio,
    });

    return Response.json({
      criteria: { minOiChangePct, minLiqRatio, candidateCount },
      results: scan,
      qualifyingCount: scan.filter((r) => r.qualifies).length,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "erreur inconnue" },
      { status: 500 }
    );
  }
}
