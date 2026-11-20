"""Fetch Robinhood Chain RPC status, on-chain proxy/implementation info, and optional Blockscout/RHJ metadata."""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
CONTRACTS_DIR = ROOT_DIR / "contracts"

RPC_ENDPOINTS = {
    "mainnet": "https://rpc.mainnet.chain.robinhood.com",
    "testnet": "https://rpc.testnet.chain.robinhood.com",
}

RHJ_ASSETS_URL = "https://api.robinhood.com/rhj/assets"
BLOCKSCOUT_BASE = "https://robinhoodchain.blockscout.com"

# Standard EIP-1967 storage slots
EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

CORE_CONTRACTS: dict[str, str] = {
    "WETH": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    "USDG": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    "StockTokenBeacon": "0xe10b6f6b275de231345c20d14ab812db62151b00",
    "L2GatewayRouter": "0x1E324B9316138CA9a73F960213621AD1aaf01B89",
    "L2ERC20Gateway": "0xfd9b17206278C16DdaacF6AC8f05dBf97EdCb31e",
    "L2ArbCustomGateway": "0x912285144fC0f6e89d3Ed16F5Ab72f87A1878959",
    "L2WethGateway": "0x1D187C3E2dA52D72BC9C41e3AbA0fdFa6a7bF055",
}

HEADERS = {
    "User-Agent": "RobinhoodChain-Research/1.0",
    "Accept": "application/json",
}


def http_json(url: str, payload: dict[str, Any] | None = None, timeout: int = 20) -> Any:
    """Perform a GET or JSON-POST request and parse the JSON response."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = dict(HEADERS)
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def rpc_call(url: str, method: str, params: list[Any]) -> Any:
    """Execute a JSON-RPC call against an EVM node."""
    res = http_json(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in res:
        raise RuntimeError(res["error"])
    return res["result"]


def slot_to_address(slot_hex: str) -> str | None:
    """Extract a 20-byte address from a 32-byte storage slot value, or None if zero."""
    clean = slot_hex.lower().removeprefix("0x").zfill(64)
    addr = "0x" + clean[-40:]
    return None if int(addr, 16) == 0 else addr


def check_rpcs() -> dict[str, Any]:
    """Check chain ID and latest block number for mainnet and testnet RPCs."""
    results: dict[str, Any] = {}
    for name, url in RPC_ENDPOINTS.items():
        try:
            cid = rpc_call(url, "eth_chainId", [])
            blk = rpc_call(url, "eth_blockNumber", [])
            results[name] = {
                "url": url,
                "chain_id": int(cid, 16),
                "latest_block": int(blk, 16),
            }
        except Exception as exc:  # noqa: BLE001
            results[name] = {"url": url, "error": str(exc)}
    return results


def inspect_onchain(label: str, address: str, rpc_url: str) -> dict[str, Any]:
    """Inspect bytecode size and EIP-1967 proxy slots directly via RPC."""
    code = rpc_call(rpc_url, "eth_getCode", [address, "latest"])
    impl = slot_to_address(rpc_call(rpc_url, "eth_getStorageAt", [address, EIP1967_IMPL_SLOT, "latest"]))
    beacon = slot_to_address(rpc_call(rpc_url, "eth_getStorageAt", [address, EIP1967_BEACON_SLOT, "latest"]))
    admin = slot_to_address(rpc_call(rpc_url, "eth_getStorageAt", [address, EIP1967_ADMIN_SLOT, "latest"]))
    return {
        "label": label,
        "address": address,
        "bytecode_bytes": (len(code) - 2) // 2 if code.startswith("0x") else 0,
        "eip1967_implementation": impl,
        "eip1967_beacon": beacon,
        "eip1967_admin": admin,
    }


def sanitize_name(name: str) -> str:
    """Convert arbitrary contract/asset names to safe filesystem names."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "Contract"


def try_fetch_blockscout(label: str, address: str) -> dict[str, Any]:
    """Attempt to fetch verified contract ABI and sources from Blockscout v2 API."""
    url = f"{BLOCKSCOUT_BASE}/api/v2/smart-contracts/{address}"
    try:
        info = http_json(url)
    except urllib.error.HTTPError as exc:
        return {"status": f"http_{exc.code}"}
    except Exception as exc:  # noqa: BLE001
        return {"status": f"error: {exc}"}

    contract_name = info.get("name") or label
    out_dir = CONTRACTS_DIR / f"{sanitize_name(label)}_{address[:10]}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metadata.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    if info.get("abi"):
        (out_dir / "abi.json").write_text(json.dumps(info["abi"], indent=2), encoding="utf-8")
    if info.get("source_code"):
        (out_dir / f"{sanitize_name(contract_name)}.sol").write_text(info["source_code"], encoding="utf-8")
    return {"status": "ok", "name": contract_name, "verified": bool(info.get("is_verified"))}


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONTRACTS_DIR.mkdir(parents=True, exist_ok=True)

    print("[1/3] Checking RPC endpoints...")
    rpc_status = check_rpcs()
    (DATA_DIR / "rpc_status.json").write_text(json.dumps(rpc_status, indent=2), encoding="utf-8")
    print(json.dumps(rpc_status, indent=2))

    mainnet_rpc = RPC_ENDPOINTS["mainnet"]
    print(f"\n[2/3] Inspecting {len(CORE_CONTRACTS)} core contracts on-chain via RPC...")
    onchain_info = []
    for label, addr in CORE_CONTRACTS.items():
        info = inspect_onchain(label, addr, mainnet_rpc)
        bs = try_fetch_blockscout(label, addr)
        info["blockscout"] = bs["status"]
        onchain_info.append(info)

    (DATA_DIR / "core_contracts_onchain.json").write_text(json.dumps(onchain_info, indent=2), encoding="utf-8")
    print(json.dumps(onchain_info, indent=2))

    print("\n[3/3] Checking RHJ assets API...")
    try:
        assets_data = http_json(RHJ_ASSETS_URL)
        (DATA_DIR / "rhj_assets.json").write_text(json.dumps(assets_data, indent=2), encoding="utf-8")
        print("Saved data/rhj_assets.json")
    except Exception as exc:  # noqa: BLE001
        print(f"RHJ assets API blocked/unavailable from CLI ({exc}). Use browser/Cantina portal if needed.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
