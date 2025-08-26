import {ChainInitializer} from "../ChainInitializer";
import {
    numberParser,
    objectParser,
    stringParser,
    enumParser
} from "@atomiqlabs/server-base";
import {
    EVMFees,
    EVMSigner,
    initializeBotanix, BotanixChainType, JsonRpcProviderWithRetries, WebSocketProviderWithRetries
} from "@atomiqlabs/chain-evm";
import {getEVMSigner} from "./signer/BaseEVMSigner";
import {EVMChainEvents} from "@atomiqlabs/chain-evm/dist/evm/events/EVMChainEvents";
import * as WebSocket from "ws";
import {EVMPersistentSigner} from "@atomiqlabs/chain-evm/dist/evm/wallet/EVMPersistentSigner";

const template = {
    RPC_URL: stringParser(),
    MAX_LOGS_BLOCK_RANGE: numberParser(false, 1, undefined, true),
    MAX_FEE_GWEI: numberParser(true, 0),
    FEE_TIP_GWEI: numberParser(true, 0, undefined, true),
    CHAIN: enumParser(["MAINNET", "TESTNET"]),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(66, 66, true),

    AUTHORIZATION_TIMEOUT: numberParser(false, 10, 3600, true)
} as const;

export const BotanixChainInitializer: ChainInitializer<BotanixChainType, any, typeof template> = {
    loadChain: (configuration, bitcoinRpc, bitcoinNetwork) => {
        const directory = process.env.STORAGE_DIR;

        const provider = configuration.RPC_URL.startsWith("ws")
            ? new WebSocketProviderWithRetries(() => new WebSocket(configuration.RPC_URL))
            : new JsonRpcProviderWithRetries(configuration.RPC_URL);

        const {chainInterface, btcRelay, swapContract, spvVaultContract} = initializeBotanix({
            rpcUrl: provider,
            chainType: configuration.CHAIN,
            maxLogsBlockRange: configuration.MAX_LOGS_BLOCK_RANGE,
            fees: new EVMFees(
                provider,
                BigInt(Math.floor(configuration.MAX_FEE_GWEI * 1_000_000_000)),
                configuration.FEE_TIP_GWEI==null ? undefined : BigInt(Math.floor(configuration.FEE_TIP_GWEI * 1_000_000_000))
            )
        }, bitcoinRpc, bitcoinNetwork);

        console.log("Init provider: ", provider);
        const evmSigner = getEVMSigner(configuration);

        const chainEvents = new EVMChainEvents(
            directory, chainInterface, swapContract, spvVaultContract,
            configuration.RPC_URL.startsWith("ws") ? 30 : undefined //We don't need to check that often when using websocket
        );

        const signer = new EVMPersistentSigner(evmSigner, evmSigner.address, chainInterface, directory+"/BOTANIX", 0n, 100_000n, 15*1000);

        return {
            signer,
            swapContract,
            chainEvents,
            btcRelay,
            chainInterface,
            spvVaultContract,
            commands: []
        };
    },
    configuration: objectParser(template, (data) => {
        if(data.MNEMONIC_FILE==null && data.PRIVKEY==null) throw new Error("Mnemonic file or explicit private key must be specified!");
    }, true)
};