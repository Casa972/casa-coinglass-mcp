// Endpoint REST pour le bot Python VPS - scan surchauffe (setup short).
// Miroir de /api/squeeze-alert mais sur les coins au funding le plus positif.

import { CoinglassAPI, buildFundingScreener, buildHeatScan } from "@/lib/coinglass";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expected = process.env.ALERT_SECRET;

  if (!expected) {
    return Response.json(
      { error: "ALERT_SECRET manquant cote serveur." },
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
    const scan = await buildHeatScan(screener.mostPositiveHourly, {
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
