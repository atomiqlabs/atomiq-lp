import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import {
    BinanceSwapPrice,
    ChainData, IBitcoinWallet, ILightningWallet, ISpvVaultSigner, ISwapPrice,
    MultichainData, OKXSwapPrice,
} from "@atomiqlabs/lp-lib";
import {
    LNDBitcoinWallet,
    LNDClient,
    LNDLightningWallet,
    OneDollarFeeEstimator
} from "@atomiqlabs/wallet-lnd";
import {BitcoindRpc} from "@atomiqlabs/btc-bitcoind";
import {IntermediaryConfig} from "./IntermediaryConfig";
import {IntermediaryRunnerWrapper} from "./runner/IntermediaryRunnerWrapper";
import {ChainInitializer, RegisteredChains} from "./chains/ChainInitializer";
import {Command} from "@atomiqlabs/server-base";
import {BITCOIN_NETWORK} from "./constants/Constants";
import {BitcoinSpvVaultSigner} from "./bitcoin/BitcoinSpvVaultSigner";
import {BitcoinNetwork} from "@atomiqlabs/base";

async function main() {
    const directory = process.env.STORAGE_DIR;

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    //Setup prices and allowed tokens
    const allowedTokens: {
        [chainIdentifier: string]: string[]
    } = {};
    const allowedDepositTokens: {
        [chainIdentifier: string]: string[]
    } = {};
    const tokenMultipliers: {
        [chainIdentifier: string]: {
            [tokenAddress: string]: bigint
        }
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
                    decimals: number,
                    securityDepositAllowed?: boolean,
                    spvVaultMultiplier?: bigint
                }
            },
            pricing: string,
            disabled?: boolean
        } = IntermediaryConfig.ASSETS[asset];
        coinMap[assetData.pricing] = assetData.chains;

        if(!assetData.disabled) for(let chain in assetData.chains) {
            if(assetData.chains[chain]==null) {
                delete assetData.chains[chain];
                continue;
            }
            if(allowedTokens[chain]==null) allowedTokens[chain] = [];
            allowedTokens[chain].push(assetData.chains[chain].address);
            if(assetData.chains[chain].securityDepositAllowed) {
                if(allowedDepositTokens[chain]==null) allowedDepositTokens[chain] = [];
                allowedDepositTokens[chain].push(assetData.chains[chain].address);
            }
            if(assetData.chains[chain].spvVaultMultiplier!=null) {
                if(tokenMultipliers[chain]==null) tokenMultipliers[chain] = {};
                tokenMultipliers[chain][assetData.chains[chain].address] = assetData.chains[chain].spvVaultMultiplier;
            }
        }
    }

    let prices: ISwapPrice<any>;
    switch(IntermediaryConfig.PRICE_SOURCE ?? "binance") {
        case "binance":
            prices = new BinanceSwapPrice(null, coinMap);
            break;
        case "okx":
            prices = new OKXSwapPrice(null, coinMap);
            break;
    }

    const bitcoinNetwork: BitcoinNetwork = BitcoinNetwork[IntermediaryConfig.BITCOIND.NETWORK.toUpperCase()];

    let bitcoinRpc: BitcoindRpc;
    let bitcoinWallet: IBitcoinWallet;
    let lightningWallet: ILightningWallet;
    let lndClient: LNDClient;
    let spvVaultSigner: ISpvVaultSigner;
    if(IntermediaryConfig.ONCHAIN_TRUSTED!=null || IntermediaryConfig.ONCHAIN!=null || IntermediaryConfig.ONCHAIN_SPV!=null) {
        bitcoinRpc = new BitcoindRpc(
            IntermediaryConfig.BITCOIND.PROTOCOL,
            IntermediaryConfig.BITCOIND.RPC_USERNAME,
            IntermediaryConfig.BITCOIND.RPC_PASSWORD,
            IntermediaryConfig.BITCOIND.HOST,
            IntermediaryConfig.BITCOIND.PORT
        );

        console.log("[Main]: Running in bitcoin "+IntermediaryConfig.BITCOIND.NETWORK+" mode!");

        const btcFeeEstimator = new OneDollarFeeEstimator(
            IntermediaryConfig.BITCOIND.HOST,
            IntermediaryConfig.BITCOIND.PORT,
            IntermediaryConfig.BITCOIND.RPC_USERNAME,
            IntermediaryConfig.BITCOIND.RPC_PASSWORD,
            IntermediaryConfig.BITCOIND?.ADD_NETWORK_FEE,
            IntermediaryConfig.BITCOIND?.MULTIPLY_NETWORK_FEE
        );
        lndClient = new LNDClient(IntermediaryConfig.LND);
        const directory = process.env.STORAGE_DIR;
        bitcoinWallet = new LNDBitcoinWallet(lndClient, {
            network: BITCOIN_NETWORK,
            feeEstimator: btcFeeEstimator,
            storageDirectory: directory+"/lndaddresspool"
        });
    }
    if(IntermediaryConfig.LN!=null || IntermediaryConfig.LN_TRUSTED!=null) {
        if(lndClient==null) lndClient = new LNDClient(IntermediaryConfig.LND);
        lightningWallet = new LNDLightningWallet(lndClient);
    }
    if(IntermediaryConfig.ONCHAIN_SPV!=null) {
        spvVaultSigner = new BitcoinSpvVaultSigner(IntermediaryConfig.ONCHAIN_SPV.MNEMONIC_FILE, BITCOIN_NETWORK);
    }

    //Create multichain data object
    const chains: {[chainId: string]: ChainData & {commands?: Command<any>[]}} = {};
    const registeredChains: {[chainId: string]: ChainInitializer<any, any, any>} = RegisteredChains;
    for(let chainId in registeredChains) {
        if(IntermediaryConfig[chainId]==null) continue;
        chains[chainId] = {
            ...registeredChains[chainId].loadChain(IntermediaryConfig[chainId], bitcoinRpc, bitcoinNetwork),
            allowedTokens: allowedTokens[chainId] ?? [],
            allowedDepositTokens: allowedDepositTokens[chainId],
            tokenMultipliers: tokenMultipliers[chainId]
        };
    }
    const multiChainData: MultichainData = {
        chains
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
            if(chainData==null) {
                console.error("Unknown chain identifier ("+chainId+") while checking tokens, known chains: "+Object.keys(chains).join());
                continue;
            }
            try {
                chainData.chainInterface.isValidToken(address);
            } catch (e) {
                console.error(e);
                throw new Error("Invalid token address specified for token: "+asset+" chain: "+chainId);
            }
        }
    }

    const runner = new IntermediaryRunnerWrapper(
        directory,
        multiChainData,
        IntermediaryConfig.ASSETS,
        prices,
        bitcoinRpc,
        bitcoinWallet,
        lightningWallet,
        spvVaultSigner
    );
    for(let chainId in chains) {
        if(chains[chainId].commands!=null) chains[chainId].commands.forEach(cmd => runner.cmdHandler.registerCommand(cmd));
    }
    await runner.init();
}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

global.atomiqLogLevel = 3;
main().catch(e => {
    console.error(e);
    process.exit(1);
});