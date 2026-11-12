// Shows the Ollama Cloud credit balance for OLLAMA_API_KEY (GET https://ollama.com/api/balance).
// Run: npm run ollama-balance
// Docs: https://docs.ollama.com/api/balance
import { OLLAMA_CLOUD_URL } from "../lib/ollama.ts";

type Balance = {
  included?: {
    balance_usd?: number;
    allowance_usd?: number;
    period?: { from?: string; until?: string };
    session?: { remaining_percent?: number; resets_at?: string };
    weekly?: { remaining_percent?: number; resets_at?: string };
  };
  purchased?: { balance_usd?: number };
};

const usd = (value: number | undefined) => (typeof value === "number" ? `$${value.toFixed(4)}` : "n/a");

async function main() {
  const key = (process.env.OLLAMA_API_KEY ?? "").trim();
  if (!key) {
    console.error("Falta OLLAMA_API_KEY en AgentJustino/.env.");
    process.exit(1);
  }

  const response = await fetch(`${OLLAMA_CLOUD_URL}/api/balance`, { headers: { Authorization: `Bearer ${key}` } });
  const text = await response.text();
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const balance = JSON.parse(text) as Balance;
  const included = balance.included ?? {};
  console.log(`Included (plan) balance: ${usd(included.balance_usd)} of ${usd(included.allowance_usd)}`);
  if (included.period) console.log(`  period: ${included.period.from} → ${included.period.until}`);
  if (included.session) console.log(`  legacy session: ${included.session.remaining_percent}% left, resets ${included.session.resets_at}`);
  if (included.weekly) console.log(`  legacy weekly: ${included.weekly.remaining_percent}% left, resets ${included.weekly.resets_at}`);
  console.log(`Purchased credits:       ${usd(balance.purchased?.balance_usd)}`);

  const total = (included.balance_usd ?? 0) + (balance.purchased?.balance_usd ?? 0);
  if (total <= 0 && !included.session && !included.weekly) {
    console.log("\n⚠️  No credits: Ollama Cloud chat will answer 402. Add credits at https://ollama.com/plans.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
