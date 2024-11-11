import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import {testnet} from "bitcoinjs-lib/src/networks";
import {BinanceSwapPrice, ChainData, MultichainData} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";
import {IntermediaryConfig} from "./IntermediaryConfig";
import {IntermediaryRunnerWrapper} from "./runner/IntermediaryRunnerWrapper";
import {ChainInitializer, RegisteredChains} from "./chains/ChainInitializer";
import {Command} from "crosslightning-server-base";

const bitcoin_chainparams = { ...testnet };
bitcoin_chainparams.bip32 = {
    public: 0x045f1cf6,
    private: 0x045f18bc,
};

async function main() {
    const directory = process.env.STORAGE_DIR;

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    //Setup prices and allowed tokens
    const allowedTokens: {
        [chainIdentifier: string]: string[]
    } = {};
    const coinMap: {
        [pair: string]: {
            [chain: string]: {
                address: string,
                decimals: number
            }
        }
    } = {};
    for(let asset in IntermediaryConfig.ASSETS) {
        const assetData: {
            chains: {
                [chain: string]: {
                    address: string,
                    decimals: number
                }
            },
            pricing: string,
            disabled?: boolean
        } = IntermediaryConfig.ASSETS[asset];
        coinMap[assetData.pricing] = assetData.chains;

        if(!assetData.disabled) for(let chain in assetData.chains) {
            if(allowedTokens[chain]==null) allowedTokens[chain] = [];
            allowedTokens[chain].push(assetData.chains[chain].address);
        }
    }
    const prices = new BinanceSwapPrice(null, coinMap);

    const bitcoinRpc = new BitcoindRpc(
        IntermediaryConfig.BITCOIND.PROTOCOL,
        IntermediaryConfig.BITCOIND.RPC_USERNAME,
        IntermediaryConfig.BITCOIND.RPC_PASSWORD,
        IntermediaryConfig.BITCOIND.HOST,
        IntermediaryConfig.BITCOIND.PORT
    );

    console.log("[Main]: Running in bitcoin "+IntermediaryConfig.BITCOIND.NETWORK+" mode!");
    console.log("[Main]: Using RPC: "+IntermediaryConfig.SOLANA.RPC_URL+"!");

    //Create multichain data object
    const chains: {[chainId: string]: ChainData & {commands?: Command<any>[]}} = {};
    const registeredChains: {[chainId: string]: ChainInitializer<any, any, any>} = RegisteredChains;
    for(let chainId in registeredChains) {
        chains[chainId] = registeredChains[chainId].loadChain(IntermediaryConfig[chainId], bitcoinRpc, allowedTokens[chainId] ?? []);
    }
    const multiChainData: MultichainData = {
        chains,
        default: "SOLANA"
    };

    //Check token addresses are valid
    for(let asset in IntermediaryConfig.ASSETS) {
        const assetData: {
            chains: {
                [chain: string]: {
                    address: string,
                    decimals: number
                }
            },
            pricing: string,
            disabled?: boolean
        } = IntermediaryConfig.ASSETS[asset];
        for(let chainId in assetData.chains) {
            const {address} = assetData.chains[chainId];
            const chainData = chains[chainId];
            if(chainData==null) throw new Error("Unknown chain identifier ("+chainId+") while checking tokens, known chains: "+Object.keys(chains).join());
            try {
                chainData.swapContract.isValidToken(address);
            } catch (e) {
                console.error(e);
                throw new Error("Invalid token address specified for token: "+asset+" chain: "+chainId);
            }
        }
    }

    const runner = new IntermediaryRunnerWrapper(directory, multiChainData, IntermediaryConfig.ASSETS, prices, bitcoinRpc);
    for(let chainId in chains) {
        if(chains[chainId].commands!=null) chains[chainId].commands.forEach(cmd => runner.cmdHandler.registerCommand(cmd));
    }
    await runner.init();
}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

main().catch(e => {
    console.error(e);
    process.exit(1);
});