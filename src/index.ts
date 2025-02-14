import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import {testnet} from "bitcoinjs-lib/src/networks";
import {
    BinanceSwapPrice,
    ChainData, IBitcoinWallet, ILightningWallet, ISwapPrice,
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
    const allowedDepositTokens: {
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
                    decimals: number,
                    securityDepositAllowed?: boolean
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

    let bitcoinRpc: BitcoindRpc;
    let bitcoinWallet: IBitcoinWallet;
    let lightningWallet: ILightningWallet;
    let lndClient: LNDClient;
    if(IntermediaryConfig.ONCHAIN_TRUSTED!=null || IntermediaryConfig.ONCHAIN!=null) {
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
            IntermediaryConfig.ONCHAIN?.ADD_NETWORK_FEE,
            IntermediaryConfig.ONCHAIN?.MULTIPLY_NETWORK_FEE
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

    //Create multichain data object
    const chains: {[chainId: string]: ChainData & {commands?: Command<any>[]}} = {};
    const registeredChains: {[chainId: string]: ChainInitializer<any, any, any>} = RegisteredChains;
    for(let chainId in registeredChains) {
        if(registeredChains[chainId]==null) continue;
        chains[chainId] = {
            ...registeredChains[chainId].loadChain(IntermediaryConfig[chainId], bitcoinRpc),
            allowedTokens: allowedTokens[chainId] ?? [],
            allowedDepositTokens: allowedDepositTokens[chainId]
        };
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

    const runner = new IntermediaryRunnerWrapper(
        directory,
        multiChainData,
        IntermediaryConfig.ASSETS,
        prices,
        bitcoinRpc,
        bitcoinWallet,
        lightningWallet
    );
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