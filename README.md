# Casa CoinGlass MCP

Serveur MCP perso qui donne a Claude un acces direct aux donnees CoinGlass
(Open Interest, Funding Rate, CVD/taker volume, Long-Short ratio, Liquidations)
pour Binance et MEXC. Teste et build verifie (Next.js 15 sur Vercel).

## 1. Abonnement CoinGlass

1. Va sur https://www.coinglass.com/pricing et prends le plan **Hobbyist** (29$/mois)
   pour commencer.
2. Une fois abonne, recupere ta cle sur ton dashboard CoinGlass (bouton "API Key").
3. Verifie dans `docs.coinglass.com` que les endpoints suivants sont bien inclus
   dans ton plan : `openInterest`, `fundingRate`, `taker-buy-sell-volume`,
   `long-short-account-ratio`, `liquidation`. S'ils ne le sont pas, passe au plan
   Startup (79$/mois).

## 2. Test en local (optionnel)

```bash
cd casa-coinglass-mcp
npm install
cp .env.example .env.local
# colle ta cle dans .env.local : COINGLASS_API_KEY=...
npm run dev
```

Le serveur MCP est servi sur `http://localhost:3000/api/mcp`.

## 3. Deploiement sur Vercel

1. Cree un repo GitHub (ex: `Casa972/casa-coinglass-mcp`) et push ce projet.
2. Sur vercel.com : "Add New Project" -> importe le repo.
3. Dans les parametres du projet Vercel, section **Environment Variables**,
   ajoute :
   - `COINGLASS_API_KEY` = ta cle CoinGlass (scope Production + Preview)
4. Deploie. Ton serveur MCP sera dispo sur :
   `https://<ton-projet>.vercel.app/api/mcp`

La cle reste cote serveur (variable d'environnement Vercel) — elle n'est
jamais exposee au navigateur ni a Claude.

## 4. Connecter a Claude

Dans Claude (claude.ai) : Parametres -> Connecteurs -> Ajouter un connecteur
personnalise -> colle l'URL `https://<ton-projet>.vercel.app/api/mcp`.

Une fois connecte, tu peux me demander directement en conversation, par
exemple : "Quel est l'OI et le funding rate actuels sur BTC, confluence avec
le CVD sur 4h ?" et j'irai chercher les donnees en direct.

## 5. Outils exposes

| Outil | Description |
|---|---|
| `get_open_interest_history` | OI en OHLC sur un intervalle donne |
| `get_open_interest_by_exchange` | OI actuel ventile par exchange |
| `get_funding_rate_history` | Funding rate en OHLC sur un intervalle donne |
| `get_funding_rate_by_exchange` | Funding rate actuel ventile par exchange |
| `get_cvd` | Volume taker buy/sell + delta cumule (CVD) calcule |
| `get_long_short_ratio` | Ratio long/short global ou top traders |
| `get_liquidations` | Historique des liquidations |

## 6. A verifier une fois la cle active

Le endpoint `taker-buy-sell-volume/history` (utilise par `get_cvd`) n'a pas pu
etre teste avec une vraie cle — je n'ai que la doc publique, pas d'acces live.
Le code tente plusieurs noms de champs courants (`buyVol`/`sellVol`,
`takerBuyVolume`/`takerSellVolume`...) pour calculer le CVD automatiquement.
Si le calcul ne se declenche pas (le tool renverra `cvd: null`), dis-le moi
avec un exemple de reponse brute (`raw`) et j'ajuste `lib/coinglass.ts` en
un instant.

Meme chose pour les parametres exacts (`interval`, `exchange`) sur chaque
endpoint : je me suis base sur la doc publique CoinGlass, une verification
rapide sur docs.coinglass.com une fois connecte confirmera les valeurs
acceptees.
