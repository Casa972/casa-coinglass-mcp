import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { CoinglassAPI, computeCvdSeries, buildFundingScreener, buildSqueezeScan, buildHeatScan, CoinglassError } from "@/lib/coinglass";
import { CoinalyzeAPI, CoinalyzeError } from "@/lib/coinalyze";
import { BinanceAPI, BinanceError } from "@/lib/binance";
import { MexcAPI, MexcError } from "@/lib/mexc";

const SYMBOL = z.string().describe("Symbole de l'actif, ex: BTC, ETH, SOL");
const INTERVAL = z
  .string()
  .optional()
  .describe(
    "Intervalle : 1m, 3m, 5m, 15m, 30m, 1h, 4h, 6h, 8h, 12h, 1d, 1w (defaut 1h). Sur le plan Hobbyist, certains endpoints exigent >=4h."
  );
const LIMIT = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe("Nombre de points a retourner (defaut 50, max 1000)");
const EXCHANGE = z
  .string()
  .optional()
  .describe("Exchange unique, ex: Binance, MEXC (defaut Binance)");
const EXCHANGE_LIST = z
  .string()
  .optional()
  .describe(
    "Liste d'exchanges separes par virgule, ex: Binance,MEXC (defaut Binance,MEXC)"
  );

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message =
    err instanceof CoinglassError
      ? `Erreur CoinGlass API (${err.status}) : ${JSON.stringify(err.body)}`
      : err instanceof CoinalyzeError
      ? `Erreur Coinalyze API (${err.status}) : ${JSON.stringify(err.body)}`
      : err instanceof BinanceError
      ? `Erreur Binance API (${err.status}) : ${JSON.stringify(err.body)}`
      : err instanceof MexcError
      ? `Erreur MEXC API (${err.status}) : ${JSON.stringify(err.body)}`
      : err instanceof Error
      ? err.message
      : "Erreur inconnue";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "get_open_interest_history",
      "Historique de l'open interest (OI) en OHLC pour une paire sur un exchange donne. Utile pour evaluer la force d'une tendance et le crowding de capital.",
      { symbol: SYMBOL, interval: INTERVAL, limit: LIMIT, exchange: EXCHANGE },
      async ({ symbol, interval, limit, exchange }) => {
        try {
          return textResult(
            await CoinglassAPI.openInterestHistory({ symbol, interval, limit, exchange })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_open_interest_by_exchange",
      "Open interest actuel d'un coin, ventile par exchange (Binance, MEXC, OKX, Bybit, CME...), avec variation % sur 5m/15m/30m/1h/4h/24h. Utile pour voir ou le capital est concentre et sa dynamique recente.",
      { symbol: SYMBOL },
      async ({ symbol }) => {
        try {
          return textResult(await CoinglassAPI.openInterestByExchange({ symbol }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_funding_rate_history",
      "Historique du funding rate (OHLC) pour une paire sur un exchange donne. Utile pour mesurer le cout de portage long/short et le sentiment du marche.",
      { symbol: SYMBOL, interval: INTERVAL, limit: LIMIT, exchange: EXCHANGE },
      async ({ symbol, interval, limit, exchange }) => {
        try {
          return textResult(
            await CoinglassAPI.fundingRateHistory({ symbol, interval, limit, exchange })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_funding_rate_by_exchange",
      "Funding rate actuel de tous les symboles, ventile par exchange (mode stablecoin-margin et coin-margin). Passe un symbole pour filtrer le resultat sur un seul actif.",
      { symbol: SYMBOL.optional().describe("Filtre optionnel, ex: BTC") },
      async ({ symbol }) => {
        try {
          const data = await CoinglassAPI.fundingRateByExchange();
          if (symbol) {
            const target = symbol.toUpperCase();
            const filtered = data.data?.filter((d) => d.symbol === target);
            return textResult(filtered);
          }
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_cvd",
      "Delta de volume cumule (CVD) pour un coin, agrege sur les exchanges donnes (Binance+MEXC par defaut). Calcule a partir du volume taker buy/sell agrege (disponible sur le plan Hobbyist). Note : l'endpoint CVD natif CoinGlass existe mais demande le plan Startup ou superieur.",
      {
        symbol: SYMBOL,
        interval: INTERVAL,
        limit: LIMIT,
        exchangeList: EXCHANGE_LIST,
      },
      async ({ symbol, interval, limit, exchangeList }) => {
        try {
          const raw = await CoinglassAPI.aggregatedTakerBuySellVolume({
            symbol,
            interval,
            limit,
            exchangeList,
          });
          const series = (raw.data ?? []).map((d) => ({
            time: d.time,
            buyVol: Number(d.aggregated_buy_volume_usd),
            sellVol: Number(d.aggregated_sell_volume_usd),
          }));
          const cvd = computeCvdSeries(series);
          return textResult({ cvd });
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_long_short_ratio",
      "Ratio long/short pour une paire : comptes globaux ou top traders. Utile pour le sentiment de marche et les signaux de retournement.",
      {
        symbol: SYMBOL,
        type: z
          .enum(["global", "top_trader"])
          .optional()
          .describe("global = tous les comptes, top_trader = gros traders (defaut global)"),
        interval: INTERVAL,
        limit: LIMIT,
        exchange: EXCHANGE,
      },
      async ({ symbol, type, interval, limit, exchange }) => {
        try {
          const data =
            type === "top_trader"
              ? await CoinglassAPI.topTraderLongShortRatio({ symbol, interval, limit, exchange })
              : await CoinglassAPI.globalLongShortRatio({ symbol, interval, limit, exchange });
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_liquidations",
      "Historique des liquidations d'un coin, agrege sur les exchanges donnes (Binance+MEXC par defaut). Utile pour detecter les zones de liquidation forcee et les niveaux de support/resistance.",
      {
        symbol: SYMBOL,
        interval: INTERVAL,
        limit: LIMIT,
        exchangeList: EXCHANGE_LIST,
      },
      async ({ symbol, interval, limit, exchangeList }) => {
        try {
          const data = await CoinglassAPI.liquidationAggregated({
            symbol,
            interval,
            limit,
            exchangeList,
          });
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    // --- Coinalyze (gratuit) : source complementaire, un seul exchange a la fois ---
    // Interet principal : le prix (OHLCV) en dessous de 4h, absent de CoinGlass
    // sur le plan Hobbyist. Les autres tools redondent avec CoinGlass mais servent
    // de repli en cas de plan API depasse ou d'ecart entre les deux sources.

    server.tool(
      "get_price_history",
      "PRIX (OHLCV) d'une paire sur un exchange, via Coinalyze - couvre les intervalles courts (1m/5m/15m) absents de CoinGlass sur le plan Hobbyist. A utiliser pour confirmer un trigger court terme sans avoir besoin d'un screenshot.",
      { symbol: SYMBOL, exchange: EXCHANGE, interval: INTERVAL, limit: LIMIT },
      async ({ symbol, exchange, interval, limit }) => {
        try {
          return textResult(await CoinalyzeAPI.ohlcvHistory({ symbol, exchange, interval, limit }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_coinalyze_funding_rate",
      "Funding rate actuel (valeur unique) pour une paire sur un exchange, via Coinalyze. Repli gratuit si CoinGlass est indisponible.",
      { symbol: SYMBOL, exchange: EXCHANGE },
      async ({ symbol, exchange }) => {
        try {
          return textResult(await CoinalyzeAPI.fundingRateCurrent({ symbol, exchange }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_coinalyze_predicted_funding_rate",
      "Funding rate PREDIT (prochaine periode, pas encore paye) pour une paire sur un exchange, via Coinalyze. CoinGlass ne donne que le funding actuel/historique, pas la prediction.",
      { symbol: SYMBOL, exchange: EXCHANGE },
      async ({ symbol, exchange }) => {
        try {
          return textResult(await CoinalyzeAPI.predictedFundingRateCurrent({ symbol, exchange }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_coinalyze_funding_rate_history",
      "Historique du funding rate (OHLC) pour une paire sur un exchange, via Coinalyze. Repli gratuit si CoinGlass est indisponible.",
      { symbol: SYMBOL, exchange: EXCHANGE, interval: INTERVAL, limit: LIMIT },
      async ({ symbol, exchange, interval, limit }) => {
        try {
          return textResult(
            await CoinalyzeAPI.fundingRateHistory({ symbol, exchange, interval, limit })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_coinalyze_open_interest",
      "Open interest actuel (USD) pour une paire sur un exchange, via Coinalyze. Repli gratuit si CoinGlass est indisponible.",
      { symbol: SYMBOL, exchange: EXCHANGE },
      async ({ symbol, exchange }) => {
        try {
          return textResult(await CoinalyzeAPI.openInterestCurrent({ symbol, exchange }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_coinalyze_open_interest_history",
      "Historique de l'open interest (OHLC, USD) pour une paire sur un exchange, via Coinalyze. Repli gratuit si CoinGlass est indisponible.",
      { symbol: SYMBOL, exchange: EXCHANGE, interval: INTERVAL, limit: LIMIT },
      async ({ symbol, exchange, interval, limit }) => {
        try {
          return textResult(
            await CoinalyzeAPI.openInterestHistory({ symbol, exchange, interval, limit })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_coinalyze_liquidations",
      "Historique des liquidations (longs/courts, USD) pour une paire sur un exchange, via Coinalyze. Repli gratuit si CoinGlass est indisponible.",
      { symbol: SYMBOL, exchange: EXCHANGE, interval: INTERVAL, limit: LIMIT },
      async ({ symbol, exchange, interval, limit }) => {
        try {
          return textResult(
            await CoinalyzeAPI.liquidationHistory({ symbol, exchange, interval, limit })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_coinalyze_long_short_ratio",
      "Historique du ratio long/short (comptes globaux) pour une paire sur un exchange, via Coinalyze. Repli gratuit si CoinGlass est indisponible.",
      { symbol: SYMBOL, exchange: EXCHANGE, interval: INTERVAL, limit: LIMIT },
      async ({ symbol, exchange, interval, limit }) => {
        try {
          return textResult(
            await CoinalyzeAPI.longShortRatioHistory({ symbol, exchange, interval, limit })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    // --- Binance / MEXC (API publiques, aucune cle) ---------------------------

    server.tool(
      "get_funding_screener",
      "Scanne TOUS les symboles disponibles sur CoinGlass (Binance+MEXC par defaut) en un seul appel et renvoie les N taux de financement les plus negatifs et les plus positifs, NORMALISES A L'HEURE (le taux brut seul trompe : un symbole a -0.14%/1h paie plus vite qu'un symbole a -0.66%/4h, alors que le brut suggere l'inverse). Remplace directement le tableau 'Taux financement' de CoinGlass que Luc consultait par capture d'ecran - fonctionne sur l'abonnement Hobbyist existant, aucune config supplementaire.",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Nombre de symboles a retourner par cote (defaut 15)"),
        exchanges: z
          .string()
          .optional()
          .describe("Liste d'exchanges separes par virgule a inclure (defaut Binance,MEXC)"),
      },
      async ({ limit, exchanges }) => {
        try {
          const raw = await CoinglassAPI.fundingRateByExchange();
          const result = buildFundingScreener(raw, {
            limit,
            exchanges: exchanges ? exchanges.split(",").map((e) => e.trim()) : undefined,
          });
          return textResult(result);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_squeeze_scan",
      "Scan multi-criteres qui reproduit la confluence identifiee manuellement sur HNT avant son pump de +19% : part des N candidats au funding le plus negatif (comme get_funding_screener), puis verifie pour chacun si l'OI construit (hausse >= seuil sur 4h), si le CVD des 2 dernieres bougies 4h est net acheteur, si les liquidations recentes sont dominees par les shorts (ratio courts/longs >= seuil), ET si le predicted funding rate Coinalyze est encore negatif (la pression se maintient pour la prochaine periode - filtre gratuit). Renvoie tous les candidats testes avec 'qualifies: true/false' et leurs metriques, pas seulement ceux qui passent - utile pour voir POURQUOI un candidat est ecarte. ATTENTION COUT API : 1 + 3xN appels CoinGlass + Nx2 appels Coinalyze (N = candidateCount). Le plan Hobbyist est limite a 30 requetes/minute - garder candidateCount <= 8 pour laisser de la marge si d'autres tools sont utilises dans la meme minute.",
      {
        candidateCount: z
          .number()
          .int()
          .min(1)
          .max(15)
          .optional()
          .describe("Nombre de candidats funding a approfondir (defaut 8 ; deconseille au-dela de 8-9 sur le plan Hobbyist a cause du rate limit 30req/min)"),
        minOiChangePct: z
          .number()
          .optional()
          .describe("Seuil de hausse OI sur 4h en % pour qualifier un candidat (defaut 5)"),
        minLiqRatio: z
          .number()
          .optional()
          .describe("Ratio liquidations courts/longs minimum pour qualifier un candidat (defaut 2)"),
      },
      async ({ candidateCount, minOiChangePct, minLiqRatio }) => {
        try {
          const fundingRaw = await CoinglassAPI.fundingRateByExchange();
          const n = candidateCount ?? 8;
          const screener = buildFundingScreener(fundingRaw, {
            limit: n * 2,
            exchanges: ["Binance", "MEXC"],
          });
          const scan = await buildSqueezeScan(screener.mostNegativeHourly, {
            minOiChangePct,
            minLiqRatio,
            maxResults: n,
          });
          return textResult({
            criteria: { minOiChangePct: minOiChangePct ?? 5, minLiqRatio: minLiqRatio ?? 2 },
            results: scan,
          });
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_binance_funding_rate",
      "Funding rate et prix actuels (mark price) pour UN symbole sur Binance, sans cle API. ATTENTION : Binance bloque les requetes en provenance d'infrastructures hebergees aux Etats-Unis (erreur 451, politique documentee depuis fin 2022) - si le deploiement Vercel tourne depuis une region US par defaut, ce tool echouera systematiquement. Preferer get_funding_screener (CoinGlass) qui fonctionne sans cette contrainte.",
      { symbol: SYMBOL },
      async ({ symbol }) => {
        try {
          return textResult(await BinanceAPI.fundingRate({ symbol }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_mexc_funding_rate",
      "Funding rate actuel pour UN symbole sur MEXC, sans cle API. Pas de version bulk cote MEXC (contrairement a Binance) - sert a recouper un candidat deja identifie, pas a scanner tout le marche MEXC.",
      { symbol: SYMBOL },
      async ({ symbol }) => {
        try {
          return textResult(await MexcAPI.fundingRate({ symbol }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_heat_scan",
      "Scan surchauffe (setup short) : miroir inverse de get_squeeze_scan. Part des N candidats au funding le plus positif (longs qui payent cher), puis verifie pour chacun si l'OI monte encore (longs qui s'accumulent), si le CVD des 2 dernieres bougies 4h est net vendeur (distribution), si les liquidations recentes sont dominees par les longs (ratio longs/shorts >= seuil), et si le predicted funding Coinalyze est encore positif (pression maintenue). Signal : le marche est surlong, les longs commencent a se faire sortir - setup short squeeze inverse. ATTENTION COUT API : 1 + 3xN appels CoinGlass (N = candidateCount).",
      {
        candidateCount: z
          .number()
          .int()
          .min(1)
          .max(15)
          .optional()
          .describe("Nombre de candidats funding a approfondir (defaut 8)"),
        minOiChangePct: z
          .number()
          .optional()
          .describe("Seuil de hausse OI sur 4h en % (defaut 5)"),
        minLiqRatio: z
          .number()
          .optional()
          .describe("Ratio liquidations longs/shorts minimum (defaut 2)"),
      },
      async ({ candidateCount, minOiChangePct, minLiqRatio }) => {
        try {
          const fundingRaw = await CoinglassAPI.fundingRateByExchange();
          const n = candidateCount ?? 8;
          const screener = buildFundingScreener(fundingRaw, {
            limit: n * 2,
            exchanges: ["Binance", "MEXC"],
          });
          const scan = await buildHeatScan(screener.mostPositiveHourly, {
            minOiChangePct,
            minLiqRatio,
            maxResults: n,
          });
          return textResult({
            criteria: { minOiChangePct: minOiChangePct ?? 5, minLiqRatio: minLiqRatio ?? 2 },
            results: scan,
            qualifyingCount: scan.filter((r) => r.qualifies).length,
          });
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST, handler as DELETE };
