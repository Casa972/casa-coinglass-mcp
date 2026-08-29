import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { CoinglassAPI, computeCvdSeries, CoinglassError } from "@/lib/coinglass";

const SYMBOL = z.string().describe("Symbole de l'actif, ex: BTC, ETH, SOL");
const INTERVAL = z
  .string()
  .optional()
  .describe("Intervalle des bougies : 1m, 5m, 15m, 1h, 4h, 1d... (defaut 1h)");
const LIMIT = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe("Nombre de points a retourner (defaut 50, max 500)");
const EXCHANGE = z
  .string()
  .optional()
  .describe("Filtrer sur un exchange precis, ex: Binance, MEXC");

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
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
    // --- Open Interest ---
    server.tool(
      "get_open_interest_history",
      "Historique de l'open interest (OI) agrege pour un actif, en OHLC sur l'intervalle demande. Utile pour evaluer la force d'une tendance et le crowding de capital.",
      {
        symbol: SYMBOL,
        interval: INTERVAL,
        limit: LIMIT,
        exchange: EXCHANGE,
      },
      async ({ symbol, interval, limit, exchange }) => {
        try {
          const data = await CoinglassAPI.openInterestOhlc({
            symbol,
            interval: interval ?? "1h",
            limit: limit ?? 50,
            exchange,
          });
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_open_interest_by_exchange",
      "Open interest actuel d'un actif, ventile par exchange (Binance, MEXC, OKX, Bybit...). Utile pour voir ou le capital est concentre.",
      { symbol: SYMBOL },
      async ({ symbol }) => {
        try {
          const data = await CoinglassAPI.openInterestByExchange({ symbol });
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    // --- Funding Rate ---
    server.tool(
      "get_funding_rate_history",
      "Historique du funding rate (OHLC) pour un actif. Utile pour mesurer le cout de portage long/short et le sentiment du marche.",
      {
        symbol: SYMBOL,
        interval: INTERVAL,
        limit: LIMIT,
        exchange: EXCHANGE,
      },
      async ({ symbol, interval, limit, exchange }) => {
        try {
          const data = await CoinglassAPI.fundingRateOhlc({
            symbol,
            interval: interval ?? "1h",
            limit: limit ?? 50,
            exchange,
          });
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    server.tool(
      "get_funding_rate_by_exchange",
      "Funding rate actuel d'un actif, ventile par exchange (Binance, MEXC...). Utile pour comparer le sentiment entre plateformes.",
      { symbol: SYMBOL },
      async ({ symbol }) => {
        try {
          const data = await CoinglassAPI.fundingRateByExchange({ symbol });
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    // --- CVD (via taker buy/sell volume) ---
    server.tool(
      "get_cvd",
      "Delta de volume cumule (CVD) approxime a partir du volume taker buy/sell. Renvoie la serie brute CoinGlass et, si le format le permet, un CVD calcule (delta cumule buy-sell).",
      {
        symbol: SYMBOL,
        interval: INTERVAL,
        limit: LIMIT,
        exchange: EXCHANGE,
      },
      async ({ symbol, interval, limit, exchange }) => {
        try {
          const data: any = await CoinglassAPI.takerBuySellVolume({
            symbol,
            interval: interval ?? "1h",
            limit: limit ?? 50,
            exchange,
          });

          // Best-effort : on tente de normaliser la serie pour calculer un CVD.
          // Les noms de champs exacts sont a verifier dans docs.coinglass.com une fois la cle active.
          let cvd: unknown = null;
          const list: any[] = Array.isArray(data)
            ? data
            : Array.isArray(data?.data)
            ? data.data
            : [];

          const normalized = list
            .map((p) => {
              const time = p.time ?? p.t ?? p.timestamp;
              const buyVol =
                p.buyVol ?? p.buy_vol ?? p.takerBuyVolume ?? p.buyVolUsd;
              const sellVol =
                p.sellVol ?? p.sell_vol ?? p.takerSellVolume ?? p.sellVolUsd;
              if (
                time !== undefined &&
                buyVol !== undefined &&
                sellVol !== undefined
              ) {
                return { time, buyVol: Number(buyVol), sellVol: Number(sellVol) };
              }
              return null;
            })
            .filter(Boolean) as Array<{
            time: number;
            buyVol: number;
            sellVol: number;
          }>;

          if (normalized.length > 0) {
            cvd = computeCvdSeries(normalized);
          }

          return textResult({ raw: data, cvd });
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    // --- Long/Short ratio ---
    server.tool(
      "get_long_short_ratio",
      "Ratio long/short pour un actif : soit le ratio global des comptes, soit celui des top traders. Utile pour le sentiment de marche et les signaux de retournement.",
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
          const params = {
            symbol,
            interval: interval ?? "1h",
            limit: limit ?? 50,
            exchange,
          };
          const data =
            type === "top_trader"
              ? await CoinglassAPI.topTraderLongShortRatio(params)
              : await CoinglassAPI.globalLongShortRatio(params);
          return textResult(data);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    // --- Liquidations ---
    server.tool(
      "get_liquidations",
      "Historique des liquidations pour un actif (par defaut agrege tous exchanges). Utile pour detecter les zones de liquidation forcee et les niveaux de support/resistance.",
      {
        symbol: SYMBOL,
        interval: INTERVAL,
        limit: LIMIT,
        exchange: EXCHANGE,
      },
      async ({ symbol, interval, limit, exchange }) => {
        try {
          const data = exchange
            ? await CoinglassAPI.liquidationHistory({
                symbol,
                interval: interval ?? "1h",
                limit: limit ?? 50,
                exchange,
              })
            : await CoinglassAPI.liquidationAggregated({
                symbol,
                interval: interval ?? "1h",
                limit: limit ?? 50,
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
