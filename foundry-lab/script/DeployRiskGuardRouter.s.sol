// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/RiskGuardRouter.sol";

interface VmScript {
    function envUint(string calldata name) external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployRiskGuardRouter {
    VmScript constant vm = VmScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Robinhood Chain Mainnet (4663): SwapRouter02
    address constant MAINNET_SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    // Robinhood Chain Testnet (46630): Classic SwapRouter
    address constant TESTNET_SWAP_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    function run() external returns (RiskGuardRouter deployed) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        bool isMainnet = block.chainid == 4663;
        address routerAddr = isMainnet ? MAINNET_SWAP_ROUTER_02 : TESTNET_SWAP_ROUTER;

        vm.startBroadcast(pk);
        deployed = new RiskGuardRouter(routerAddr, isMainnet);
        vm.stopBroadcast();
    }
}
