import {BitcoinRpc, ChainType, SwapData} from "@atomiqlabs/base";
import {ChainData} from "@atomiqlabs/lp-lib";
import {ConfigParser, ConfigTemplate, ParsedConfig, Command} from "@atomiqlabs/server-base";
import {SolanaChainInitializer} from "./solana/SolanaChainInitializer";

export type ChainInitializer<T extends ChainType, C, V extends ConfigTemplate<C>> = {
    loadChain: (configuration: ParsedConfig<C, V>, bitcoinRpc: BitcoinRpc<any>, allowedTokens: string[]) => ChainData<T> & {commands?: Command<any>[]},
    configuration: ConfigParser<ParsedConfig<C, V>>
};

export const RegisteredChains = {
    SOLANA: SolanaChainInitializer
}
