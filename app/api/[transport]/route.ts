import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { CoinglassAPI, computeCvdSeries, CoinglassError } from "@/lib/coinglass";

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
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST, handler as DELETE };
