"""Audit live Stock Token multipliers, Chainlink feeds, and core registry state on Robinhood Chain."""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
REGISTRY_PATH = ROOT_DIR / "reference" / "robinhood-chain-sdk" / "src" / "registry" / "stock-tokens.json"
OUT_PATH = ROOT_DIR / "data" / "onchain_pricing_audit.json"
RPC_URL = "https://rpc.mainnet.chain.robinhood.com"

# Function selectors (verified via `cast sig`)
SEL_UI_MULTIPLIER = "0xa60bf13d"  # uiMultiplier()
SEL_LATEST_ROUND_DATA = "0xfeaf968c"  # latestRoundData()
SEL_ORACLE_PAUSED = "0x7706ba52"  # oraclePaused()
SEL_PAUSED = "0x5c975abb"  # paused()


def rpc_call(method: str, params: list[Any]) -> Any:
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8")
    req = urllib.request.Request(
        RPC_URL,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "RobinhoodChain-Research/1.0"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "error" in data:
        raise RuntimeError(data["error"])
    return data["result"]


def eth_call(to: str, selector: str) -> str:
    return rpc_call("eth_call", [{"to": to, "data": selector}, "latest"])


def decode_uint(hex_str: str, word_index: int = 0) -> int:
    clean = hex_str.removeprefix("0x")
    start = word_index * 64
    return int(clean[start : start + 64], 16)


def main() -> int:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    tokens = registry["tokens"]
    now = int(time.time())

    anomalies: list[dict[str, Any]] = []
    feed_results: list[dict[str, Any]] = []

    print(f"Auditing {len(tokens)} Stock Tokens on mainnet (chainId 4663)...")
    for tok in tokens:
        sym = tok["symbol"]
        addr = tok["address"]
        feed = tok.get("feed")

        try:
            mult = decode_uint(eth_call(addr, SEL_UI_MULTIPLIER))
            is_paused = bool(decode_uint(eth_call(addr, SEL_PAUSED)))
            oracle_paused = bool(decode_uint(eth_call(addr, SEL_ORACLE_PAUSED)))
        except Exception as exc:  # noqa: BLE001
            anomalies.append({"symbol": sym, "address": addr, "issue": f"token_call_failed: {exc}"})
            continue

        if mult == 0:
            anomalies.append({"symbol": sym, "address": addr, "issue": "uiMultiplier is 0"})
        if is_paused or oracle_paused:
            anomalies.append({
                "symbol": sym,
                "address": addr,
                "issue": "paused_state",
                "paused": is_paused,
                "oraclePaused": oracle_paused,
            })

        if feed:
            try:
                res = eth_call(feed, SEL_LATEST_ROUND_DATA)
                round_id = decode_uint(res, 0)
                answer = decode_uint(res, 1)
                updated_at = decode_uint(res, 3)
                age_hours = round((now - updated_at) / 3600, 2)
                entry = {
                    "symbol": sym,
                    "token": addr,
                    "feed": feed,
                    "uiMultiplier": str(mult),
                    "answer_8dec": answer,
                    "updated_at": updated_at,
                    "age_hours": age_hours,
                    "round_id": str(round_id),
                }
                feed_results.append(entry)
                if answer == 0 or updated_at == 0 or age_hours > 96:
                    anomalies.append({
                        "symbol": sym,
                        "feed": feed,
                        "issue": "feed_anomaly",
                        "answer": answer,
                        "age_hours": age_hours,
                    })
            except Exception as exc:  # noqa: BLE001
                anomalies.append({"symbol": sym, "feed": feed, "issue": f"feed_call_failed: {exc}"})

    report = {
        "timestamp": now,
        "tokens_checked": len(tokens),
        "feeds_checked": len(feed_results),
        "anomalies_count": len(anomalies),
        "anomalies": anomalies,
        "feeds": feed_results,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Done. Tokens: {len(tokens)}, Feeds: {len(feed_results)}, Anomalies: {len(anomalies)}")
    if anomalies:
        print(json.dumps(anomalies, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
