import {BitcoinNetwork, BitcoinRpc, ChainType} from "@atomiqlabs/base";
import {ChainData} from "@atomiqlabs/lp-lib";
import {ConfigParser, ConfigTemplate, ParsedConfig, Command} from "@atomiqlabs/server-base";
import {SolanaChainInitializer} from "./solana/SolanaChainInitializer";
import {StarknetChainInitializer} from "./starknet/StarknetChainInitializer";

export type ChainInitializer<T extends ChainType, C, V extends ConfigTemplate<C>> = {
    loadChain: (configuration: ParsedConfig<C, V>, bitcoinRpc: BitcoinRpc<any>, bitcoinNetwork: BitcoinNetwork) => Omit<ChainData<T>, "allowedTokens"> & {commands?: Command<any>[]},
    configuration: ConfigParser<ParsedConfig<C, V>>
};

export const RegisteredChains = {
    SOLANA: SolanaChainInitializer,
    STARKNET: StarknetChainInitializer
}
