import {BitcoinRpc, ChainType, SwapData} from "crosslightning-base";
import {ChainData} from "crosslightning-intermediary";
import {ConfigParser, ConfigTemplate, ParsedConfig, Command} from "crosslightning-server-base";
import {SolanaChainInitializer} from "./solana/SolanaChainInitializer";

export type ChainInitializer<T extends ChainType, C, V extends ConfigTemplate<C>> = {
    loadChain: (configuration: ParsedConfig<C, V>, bitcoinRpc: BitcoinRpc<any>, allowedTokens: string[]) => ChainData<T> & {commands?: Command<any>[]},
    configuration: ConfigParser<ParsedConfig<C, V>>
};

export const RegisteredChains = {
    SOLANA: SolanaChainInitializer
}
