import {getEnabledPlugins} from "../plugins";
import {
    AUTHORIZATION_TIMEOUT,
    BITCOIN_BLOCKTIME, CHAIN_SEND_SAFETY_FACTOR,
    GRACE_PERIOD, REFUND_AUTHORIZATION_TIMEOUT,
    SAFETY_FACTOR
} from "../constants/Constants";
import {IntermediaryConfig} from "../IntermediaryConfig";
import * as http2 from "http2";
import * as fs from "fs/promises";
import {
    FromBtcAbs,
    FromBtcLnAbs, FromBtcLnTrusted, FromBtcTrusted,
    InfoHandler,
    IntermediaryStorageManager,
    ISwapPrice, MultichainData,
    PluginManager,
    SwapHandler,
    SwapHandlerSwap,
    ToBtcAbs,
    ToBtcLnAbs,
    IBitcoinWallet,
    ILightningWallet, ISpvVaultSigner, SpvVaultSwapHandler, StorageManager
} from "@atomiqlabs/lp-lib";
import {BitcoinRpc, BtcSyncInfo} from "@atomiqlabs/base";
import http2Express from "http2-express-bridge";
import * as express from "express";
import * as cors from "cors";
import {LetsEncryptACME} from "../LetsEncryptACME";
import * as tls from "node:tls";
import {EventEmitter} from "node:events";
import {fromDecimal} from "@atomiqlabs/server-base";
import {createHttpRateLimiter} from "../http/HttpRateLimiter";
import {createConnectionRateLimiter} from "../http/ConnectionRateLimiter";
import {createBodySizeLimiter} from "../http/BodySizeLimiter";

export enum IntermediaryInitState {
    STARTING="starting",
    WAIT_BTC_RPC="wait_btc_rpc",
    WAIT_BTC_WALLET="wait_btc_wallet",
    WAIT_LIGHTNING_WALLET="wait_lightning_wallet",
    CONTRACT_INIT="wait_contract_init",
    LOAD_PLUGINS="load_plugins",
    REGISTER_HANDLERS="register_handlers",
    INIT_HANDLERS="init_handlers",
    INIT_EVENTS="init_events",
    INIT_WATCHDOGS="init_watchdogs",
    START_REST="start_rest",
    READY="ready"
}

function removeAllowedAssets(handler: SwapHandler<any>, assets: string[]) {
    if(assets==null) return;
    assets.forEach(val => {
        const arr = val.split("-");
        if(arr.length!=2) return;
        const [chain, asset] = arr;
        const assetData = IntermediaryConfig.ASSETS[asset];
        if(assetData==null) return;
        const address = assetData.chains[chain]?.address;
        if(address==null) return;
        const handlerAssetSet = handler.allowedTokens[chain];
        if(handlerAssetSet==null) return;
        handlerAssetSet.delete(address);
    })
}

export class IntermediaryRunner extends EventEmitter {

    readonly directory: string;
    readonly tokens: {
        [ticker: string]: {
            chains: {
                [chainIdentifier: string] : {
                    address: string,
                    decimals: number,
                }
            }
            pricing: string,
            disabled?: boolean
        }
    };
    readonly prices: ISwapPrice;
    readonly multichainData: MultichainData;

    readonly bitcoinRpc?: BitcoinRpc<any>;
    readonly bitcoinWallet?: IBitcoinWallet;
    readonly lightningWallet?: ILightningWallet;
    readonly spvVaultSigner?: ISpvVaultSigner;

    readonly swapHandlers: SwapHandler<any>[] = [];
    spvSwapHandler: SpvVaultSwapHandler;
    infoHandler: InfoHandler;

    initState: IntermediaryInitState = IntermediaryInitState.STARTING;
    sslAutoUrl: string;

    setState(newState: IntermediaryInitState) {
        const oldState = this.initState;
        this.initState = newState;
        super.emit("state", newState, oldState);
    }

    constructor(
        directory: string,
        multichainData: MultichainData,
        tokens: {
            [ticker: string]: {
                chains: {
                    [chainIdentifier: string] : {
                        address: string,
                        decimals: number,
                    }
                }
                pricing: string,
                disabled?: boolean
            }
        },
        prices: ISwapPrice,
        bitcoinRpc: BitcoinRpc<any>,
        bitcoinWallet: IBitcoinWallet,
        lightningWallet: ILightningWallet,
        spvVaultSigner: ISpvVaultSigner
    ) {
        super();
        this.directory = directory;
        this.multichainData = multichainData;
        this.tokens = tokens;
        this.prices = prices;
        this.bitcoinRpc = bitcoinRpc;
        this.bitcoinWallet = bitcoinWallet;
        this.lightningWallet = lightningWallet;
        this.spvVaultSigner = spvVaultSigner;
    }

    /**
     * Checks if IBD on the bitcoind has finished yet
     */
    async waitForBitcoinRpc() {
        console.log("[Main] Waiting for bitcoin RPC...");
        let rpcState: BtcSyncInfo = null;
        while(rpcState==null || rpcState.ibd) {
            rpcState = await this.bitcoinRpc.getSyncInfo().catch(e => {
                console.error(e);
                return null;
            });
            console.log("[Main] Bitcoin RPC state: ", rpcState==null ? "offline" : rpcState.ibd ? "IBD" : "ready");
            if(rpcState==null || rpcState.ibd) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("[Main] Bitcoin RPC ready, continue");
    }

    async registerPlugins(): Promise<void> {
        const tokenData: {
            [chainId: string]: {
                [ticker: string]: {
                    address: string,
                    decimals: number
                }
            }
        } = {};
        for(let ticker in this.tokens) {
            for(let chainId in this.tokens[ticker].chains) {
                tokenData[chainId] ??= {};
                tokenData[chainId][ticker] = this.tokens[ticker].chains[chainId];
            }
        }
        const plugins = await getEnabledPlugins();
        plugins.forEach(pluginData => PluginManager.registerPlugin(pluginData.name, pluginData.plugin));
        await PluginManager.enable(
            this.multichainData,
            this.bitcoinRpc,
            this.bitcoinWallet,
            this.lightningWallet,
            this.prices,
            tokenData,
            process.env.PLUGINS_DIR
        );
    }

    registerSwapHandlers(): void {

        const initAuthorizationTimeouts = {};
        for(let chain in IntermediaryConfig) {
            if(IntermediaryConfig[chain]?.AUTHORIZATION_TIMEOUT!=null) {
                initAuthorizationTimeouts[chain] = IntermediaryConfig[chain].AUTHORIZATION_TIMEOUT;
            }
        }

        const globalConfig = {
            initAuthorizationTimeout: AUTHORIZATION_TIMEOUT,
            initAuthorizationTimeouts,
            bitcoinBlocktime: BITCOIN_BLOCKTIME,
            safetyFactor: SAFETY_FACTOR,
            swapCheckInterval: 5*60*1000,
            refundAuthorizationTimeout: REFUND_AUTHORIZATION_TIMEOUT,
            gracePeriod: GRACE_PERIOD,
            securityDepositAPY: Number(IntermediaryConfig.SECURITY_DEPOSIT_APY ?? IntermediaryConfig.SOLANA.SECURITY_DEPOSIT_APY)/1000000
        };

        if(IntermediaryConfig.ONCHAIN!=null) {
            const swapConfig = {
                baseFee: IntermediaryConfig.ONCHAIN.BASE_FEE,
                feePPM: IntermediaryConfig.ONCHAIN.FEE_PERCENTAGE
            };
            const tobtc = new ToBtcAbs(
                new IntermediaryStorageManager(this.directory + "/tobtc"),
                "/tobtc",
                this.multichainData,
                this.bitcoinWallet,
                this.prices,
                this.bitcoinRpc,
                {
                    ...globalConfig,
                    ...swapConfig,
                    sendSafetyFactor: CHAIN_SEND_SAFETY_FACTOR,

                    minChainCltv: 10n,

                    networkFeeMultiplier: 1+(IntermediaryConfig.ONCHAIN.NETWORK_FEE_ADD_PERCENTAGE/100),
                    minConfirmations: 1,
                    maxConfirmations: 6,
                    maxConfTarget: 12,
                    minConfTarget: 1,

                    txCheckInterval: 10 * 1000,

                    max: IntermediaryConfig.ONCHAIN.MAX_TO_BTC ?? IntermediaryConfig.ONCHAIN.MAX,
                    min: IntermediaryConfig.ONCHAIN.MIN_TO_BTC ?? IntermediaryConfig.ONCHAIN.MIN
                }
            );
            removeAllowedAssets(tobtc, IntermediaryConfig.ONCHAIN.EXCLUDE_ASSETS);
            this.swapHandlers.push(tobtc);
            const frombtc = new FromBtcAbs(
                new IntermediaryStorageManager(this.directory + "/frombtc"),
                "/frombtc",
                this.multichainData,
                this.bitcoinWallet,
                this.prices,
                {
                    ...globalConfig,
                    ...swapConfig,

                    confirmations: 2,
                    swapCsvDelta: 72,

                    max: IntermediaryConfig.ONCHAIN.MAX_FROM_BTC ?? IntermediaryConfig.ONCHAIN.MAX,
                    min: IntermediaryConfig.ONCHAIN.MIN_FROM_BTC ?? IntermediaryConfig.ONCHAIN.MIN
                }
            );
            removeAllowedAssets(frombtc, IntermediaryConfig.ONCHAIN.EXCLUDE_ASSETS);
            this.swapHandlers.push(frombtc);
        }

        if(IntermediaryConfig.ONCHAIN_SPV!=null) {
            const gasTokenMax = {};
            for(let chainId in IntermediaryConfig.ONCHAIN_SPV.GAS_MAX) {
                if(IntermediaryConfig.ONCHAIN_SPV.GAS_MAX[chainId]==null) continue;
                const tokenData = this.prices.getTokenData(this.multichainData.chains[chainId].chainInterface.getNativeCurrencyAddress(), chainId);
                gasTokenMax[chainId] = fromDecimal(IntermediaryConfig.ONCHAIN_SPV.GAS_MAX[chainId].toFixed(tokenData.decimals), tokenData.decimals);
            }
            const swapConfig = {
                baseFee: IntermediaryConfig.ONCHAIN_SPV.BASE_FEE,
                feePPM: IntermediaryConfig.ONCHAIN_SPV.FEE_PERCENTAGE,
                max: IntermediaryConfig.ONCHAIN_SPV.MAX,
                min: IntermediaryConfig.ONCHAIN_SPV.MIN,
                gasTokenMax
            };

            if(this.spvVaultSigner!=null) {
                this.spvSwapHandler = new SpvVaultSwapHandler(
                    new IntermediaryStorageManager(this.directory + "/frombtc_spv"),
                    new StorageManager(this.directory+"/frombtc_spv_vaults"),
                    "/frombtc_spv",
                    this.multichainData,
                    this.prices,
                    this.bitcoinWallet,
                    this.bitcoinRpc,
                    this.spvVaultSigner,
                    {
                        ...globalConfig,
                        ...swapConfig,

                        vaultsCheckInterval: 60*1000,
                        maxUnclaimedWithdrawals: 5
                    }
                );
                removeAllowedAssets(this.spvSwapHandler, IntermediaryConfig.ONCHAIN_SPV.EXCLUDE_ASSETS);
                this.swapHandlers.push(this.spvSwapHandler);
            }
        }

        if(IntermediaryConfig.LN!=null) {
            const swapConfig = {
                baseFee: IntermediaryConfig.LN.BASE_FEE,
                feePPM: IntermediaryConfig.LN.FEE_PERCENTAGE,
                max: IntermediaryConfig.LN.MAX,
                min: IntermediaryConfig.LN.MIN,
            };
            const tobtcln = new ToBtcLnAbs(
                new IntermediaryStorageManager(this.directory+"/tobtcln"),
                "/tobtcln",
                this.multichainData,
                this.lightningWallet,
                this.prices,
                {
                    ...globalConfig,
                    ...swapConfig,

                    routingFeeMultiplier: 2n,

                    minSendCltv: 10n,

                    allowShortExpiry: IntermediaryConfig.LN.ALLOW_LN_SHORT_EXPIRY,
                    allowProbeFailedSwaps: IntermediaryConfig.LN.ALLOW_NON_PROBABLE_SWAPS,
                }
            );
            removeAllowedAssets(tobtcln, IntermediaryConfig.LN.EXCLUDE_ASSETS);
            this.swapHandlers.push(tobtcln);
            const frombtcln = new FromBtcLnAbs(
                new IntermediaryStorageManager(this.directory+"/frombtcln"),
                "/frombtcln",
                this.multichainData,
                this.lightningWallet,
                this.prices,
                {
                    ...globalConfig,
                    ...swapConfig,

                    minCltv: 20n,

                    swapCheckInterval: 1*60*1000,
                    invoiceTimeoutSeconds: IntermediaryConfig.LN.INVOICE_EXPIRY_SECONDS
                }
            );
            removeAllowedAssets(frombtcln, IntermediaryConfig.LN.EXCLUDE_ASSETS);
            this.swapHandlers.push(frombtcln);
        }
        if(IntermediaryConfig.ONCHAIN_TRUSTED!=null) {
            this.swapHandlers.push(
                new FromBtcTrusted(
                    new IntermediaryStorageManager(this.directory + "/frombtc_trusted"),
                    "/frombtc_trusted",
                    this.multichainData,
                    this.bitcoinWallet,
                    this.prices,
                    this.bitcoinRpc,
                    {
                        ...globalConfig,
                        baseFee: IntermediaryConfig.ONCHAIN_TRUSTED.BASE_FEE,
                        feePPM: IntermediaryConfig.ONCHAIN_TRUSTED.FEE_PERCENTAGE,
                        max: IntermediaryConfig.ONCHAIN_TRUSTED.MAX,
                        min: IntermediaryConfig.ONCHAIN_TRUSTED.MIN,

                        doubleSpendCheckInterval: 5000,
                        swapAddressExpiry: IntermediaryConfig.ONCHAIN_TRUSTED.SWAP_EXPIRY_SECONDS ?? 3*3600,
                        recommendFeeMultiplier: 1
                    }
                )
            );
        }
        if(IntermediaryConfig.LN_TRUSTED!=null) {
            this.swapHandlers.push(
                new FromBtcLnTrusted(
                    new IntermediaryStorageManager(this.directory+"/frombtcln_trusted"),
                    "/lnforgas",
                    this.multichainData,
                    this.lightningWallet,
                    this.prices,
                    {
                        ...globalConfig,
                        baseFee: IntermediaryConfig.LN_TRUSTED.BASE_FEE,
                        feePPM: IntermediaryConfig.LN_TRUSTED.FEE_PERCENTAGE,
                        max: IntermediaryConfig.LN_TRUSTED.MAX,
                        min: IntermediaryConfig.LN_TRUSTED.MIN,

                        minCltv: 20n,

                        swapCheckInterval: 1*60*1000,
                        invoiceTimeoutSeconds: IntermediaryConfig.LN_TRUSTED.INVOICE_EXPIRY_SECONDS
                    }
                )
            );
        }
    }

    initSwapHandlers(): Promise<void[]> {
        return Promise.all(this.swapHandlers.map(service => service.init()));
    }

    startHandlerWatchdogs(): Promise<void[]> {
        return Promise.all(this.swapHandlers.map(service => service.startWatchdog()));
    }

    async startRestServer() {

        let useSsl = false;
        let key: Buffer;
        let cert: Buffer;

        let server: http2.Http2Server | http2.Http2SecureServer;

        const renewCallback = (_key: Buffer, _cert: Buffer) => {
            key = _key;
            cert = _cert;
            if(server instanceof tls.Server) {
                server.setSecureContext({
                    key,
                    cert
                });
            }
        }

        const listenPort = IntermediaryConfig.REST.PORT;

        if(IntermediaryConfig.SSL_AUTO!=null) {
            console.log("[Main]: Using automatic SSL cert provision through Let's Encrypt & dns proxy: "+IntermediaryConfig.SSL_AUTO.DNS_PROXY);
            useSsl = true;
            let address: string;
            if(IntermediaryConfig.SSL_AUTO.IP_ADDRESS_FILE!=null) {
                try {
                    const addressBuff = await fs.readFile(IntermediaryConfig.SSL_AUTO.IP_ADDRESS_FILE);
                    address = addressBuff.toString();
                } catch (e) {
                    console.error(e);
                    throw new Error("Cannot read SSL_AUTO.IP_ADDRESS_FILE");
                }
            } else {
                //@ts-ignore
                const publicIpLib = await eval("import(\"public-ip\")");
                address = await publicIpLib.publicIpv4();
            }
            if(address==null) throw new Error("Cannot get IP address of the node!");
            console.log("[Main]: IP address: "+address);
            const dir = this.directory+"/ssl";
            try {
                await fs.mkdir(dir);
            } catch (e) {}

            const ipWithDashes = address.replace(new RegExp("\\.", 'g'), "-");
            const dnsNames = IntermediaryConfig.SSL_AUTO.DNS_PROXY.split(",").map(domain => ipWithDashes.split(",").map(ip => ip+"."+domain)).flat();
            console.log("[Main]: Domain name: "+dnsNames.join(", "));
            const acme = new LetsEncryptACME(dnsNames, dir+"/key.pem", dir+"/cert.pem", IntermediaryConfig.SSL_AUTO.HTTP_LISTEN_PORT, IntermediaryConfig.SSL_AUTO.HTTP_LISTEN_ADDRESS);

            const url = "https://"+dnsNames[0]+":"+listenPort;
            this.sslAutoUrl = url;
            await fs.writeFile(this.directory+"/url.txt", url);

            await acme.init(renewCallback);
        }
        if(IntermediaryConfig.SSL!=null) {
            console.log("[Main]: Using existing SSL certs");
            useSsl = true;

            key = await fs.readFile(IntermediaryConfig.SSL.KEY_FILE);
            cert = await fs.readFile(IntermediaryConfig.SSL.CERT_FILE);

            (async() => {
                for await (let change of fs.watch(IntermediaryConfig.SSL.KEY_FILE)) {
                    if(change.eventType==="change") {
                        try {
                            renewCallback(
                                await fs.readFile(IntermediaryConfig.SSL.KEY_FILE),
                                await fs.readFile(IntermediaryConfig.SSL.CERT_FILE)
                            );
                            console.log("IntermediaryRunner: SSL KEY watcher: Updated server certificate!");
                        } catch (e) {
                            console.log("SSL KEY watcher error: ", e);
                            console.error(e);
                        }
                    }
                }
            })();
            (async() => {
                for await (let change of fs.watch(IntermediaryConfig.SSL.CERT_FILE)) {
                    if(change.eventType==="change") {
                        try {
                            renewCallback(
                                await fs.readFile(IntermediaryConfig.SSL.KEY_FILE),
                                await fs.readFile(IntermediaryConfig.SSL.CERT_FILE)
                            );
                            console.log("IntermediaryRunner: SSL CERT watcher: Updated server certificate!");
                        } catch (e) {
                            console.log("SSL CERT watcher error: ", e);
                            console.error(e);
                        }
                    }
                }
            })();
        }

        const restServer = http2Express(express) as express.Express;
        restServer.use(createBodySizeLimiter(8*1024));
        restServer.use(createHttpRateLimiter(IntermediaryConfig.REST.REQUEST_LIMIT?.LIMIT, IntermediaryConfig.REST.REQUEST_LIMIT?.WINDOW_MS));
        restServer.use(createConnectionRateLimiter(IntermediaryConfig.REST.CONNECTION_LIMIT));
        restServer.use(cors());

        for(let swapHandler of this.swapHandlers) {
            swapHandler.startRestServer(restServer);
        }
        this.infoHandler.startRestServer(restServer);

        await PluginManager.onHttpServerStarted(restServer);

        if(!useSsl) {
            server = http2.createServer(restServer);
        } else {
            server = http2.createSecureServer(
                {
                    key,
                    cert,
                    allowHTTP1: true
                },
                restServer
            );
        }

        server.setTimeout(IntermediaryConfig.REST.CONNECTION_TIMEOUT_MS ?? 15 * 1000);

        await new Promise<void>((resolve, reject) => {
            server.on("error", e => reject(e));
            server.listen(listenPort, IntermediaryConfig.REST.ADDRESS, () => resolve());
        });

        console.log("[Main]: Rest server listening on port: "+listenPort+" ssl: "+useSsl);
    }

    async init() {
        if(this.bitcoinRpc!=null) {
            this.setState(IntermediaryInitState.WAIT_BTC_RPC);
            await this.waitForBitcoinRpc();
        }
        if(this.bitcoinWallet!=null) {
            this.setState(IntermediaryInitState.WAIT_BTC_WALLET);
            await this.bitcoinWallet.init();
        }
        if(this.lightningWallet!=null) {
            this.setState(IntermediaryInitState.WAIT_LIGHTNING_WALLET);
            await this.lightningWallet.init();
        }
        if(this.spvVaultSigner!=null) {
            await this.spvVaultSigner.init();
        }

        this.setState(IntermediaryInitState.CONTRACT_INIT);
        for(let chainId in this.multichainData.chains) {
            await this.multichainData.chains[chainId].swapContract.start();
        }
        console.log("[Main]: Swap contract initialized!");

        this.setState(IntermediaryInitState.LOAD_PLUGINS);
        await this.registerPlugins();

        console.log("[Main]: Plugins registered!");

        this.setState(IntermediaryInitState.REGISTER_HANDLERS);
        this.registerSwapHandlers();
        this.infoHandler = new InfoHandler(this.multichainData, "", this.swapHandlers);

        console.log("[Main]: Swap handlers registered!");

        this.setState(IntermediaryInitState.INIT_HANDLERS);
        await this.initSwapHandlers();

        console.log("[Main]: Swap handlers initialized!");

        this.setState(IntermediaryInitState.INIT_EVENTS);
        for(let chainId in this.multichainData.chains) {
            const chainData = this.multichainData.chains[chainId];
            await chainData.swapContract.start();
            if(chainData.swapContract.claimDeposits!=null) await chainData.swapContract.claimDeposits(chainData.signer, {waitForConfirmation: true});
            await chainData.chainEvents.init();
        }

        console.log("[Main]: Chain events synchronized!");

        this.setState(IntermediaryInitState.INIT_WATCHDOGS);
        await this.startHandlerWatchdogs();

        console.log("[Main]: Watchdogs started!");

        this.setState(IntermediaryInitState.START_REST);
        await this.startRestServer();

        this.setState(IntermediaryInitState.READY);
    }

}