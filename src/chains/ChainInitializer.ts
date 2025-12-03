import {BitcoinNetwork, BitcoinRpc, ChainType} from "@atomiqlabs/base";
import {ChainData} from "@atomiqlabs/lp-lib";
import {ConfigParser, ConfigTemplate, ParsedConfig, Command} from "@atomiqlabs/server-base";
import {SolanaChainInitializer} from "./solana/SolanaChainInitializer";
import {StarknetChainInitializer} from "./starknet/StarknetChainInitializer";
import {CitreaChainInitializer} from "./evm/CitreaChainInitializer";
import {BotanixChainInitializer} from "./evm/BotanixChainInitializer";
import {AlpenChainInitializer} from "./evm/AlpenChainInitializer";
import {GoatChainInitializer} from "./evm/GoatChainInitializer";

export type ChainInitializer<T extends ChainType, C, V extends ConfigTemplate<C>> = {
    loadChain: (configuration: ParsedConfig<C, V>, bitcoinRpc: BitcoinRpc<any>, bitcoinNetwork: BitcoinNetwork) => Omit<ChainData<T>, "allowedTokens"> & {commands?: Command<any>[], minNativeBalanceReserve?: bigint},
    configuration: ConfigParser<ParsedConfig<C, V>>
};

export const RegisteredChains = {
    SOLANA: SolanaChainInitializer,
    STARKNET: StarknetChainInitializer,
    CITREA: CitreaChainInitializer,
    BOTANIX: BotanixChainInitializer,
    ALPEN: AlpenChainInitializer,
    GOAT: GoatChainInitializer
}
