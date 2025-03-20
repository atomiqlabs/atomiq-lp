import {ChainInitializer} from "../ChainInitializer";
import {
    numberParser,
    objectParser,
    stringParser,
    enumParser
} from "@atomiqlabs/server-base";
import {
    StarknetBtcRelay, StarknetChainInterface,
    StarknetChainType,
    StarknetFees,
    StarknetSigner, StarknetSpvVaultContract,
    StarknetSwapContract
} from "@atomiqlabs/chain-starknet";
import {getStarknetSigner} from "./signer/StarknetSigner";
import {constants, RpcProvider} from "starknet";
import {StarknetChainEvents} from "@atomiqlabs/chain-starknet/dist/starknet/events/StarknetChainEvents";

const template = {
    RPC_URL: stringParser(),
    MAX_FEE_GWEI: numberParser(false, 0),
    FEE_TOKEN: enumParser(["STRK", "ETH"]),
    CHAIN: enumParser(["MAIN", "SEPOLIA"]),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(66, 66, true),

    AUTHORIZATION_TIMEOUT: numberParser(false, 10, 3600, true)
};

export const StarknetChainInitializer: ChainInitializer<StarknetChainType, any, typeof template> = {
    loadChain: (configuration, bitcoinRpc) => {
        const directory = process.env.STORAGE_DIR;

        const chainId = configuration.CHAIN==="MAIN" ? constants.StarknetChainId.SN_MAIN : constants.StarknetChainId.SN_SEPOLIA;

        const provider = new RpcProvider({nodeUrl: configuration.RPC_URL});
        const starknetSigner = getStarknetSigner(configuration, provider);

        const starknetFees = new StarknetFees(provider, configuration.FEE_TOKEN, configuration.MAX_FEE_GWEI*1000000000);

        const chainInterface = new StarknetChainInterface(chainId, provider, undefined, starknetFees);

        const btcRelay = new StarknetBtcRelay(
            chainInterface, bitcoinRpc
        );

        const swapContract = new StarknetSwapContract(
            chainInterface, btcRelay
        );

        const spvVaultContract = new StarknetSpvVaultContract(
            chainInterface, btcRelay, bitcoinRpc
        );

        const chainEvents = new StarknetChainEvents(directory, chainInterface, swapContract, spvVaultContract);

        const signer = new StarknetSigner(starknetSigner);

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