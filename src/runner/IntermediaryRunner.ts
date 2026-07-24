import {getEnabledPlugins} from "../plugins";
import {
    AUTHORIZATION_TIMEOUT,
    BITCOIN_BLOCKTIME, CHAIN_SEND_SAFETY_FACTOR,
    GRACE_PERIOD, LN_SAFETY_FACTOR_OVERRIDE_PPM, REFUND_AUTHORIZATION_TIMEOUT,
    SAFETY_FACTOR
} from "../constants/Constants";
import {IntermediaryConfig} from "../IntermediaryConfig";
import * as http2 from "node:http2";
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
    ILightningWallet, ISpvVaultSigner, SpvVaultSwapHandler, StorageManager, FromBtcLnAuto
} from "@atomiqlabs/lp-lib";
import {BitcoinRpc, BtcSyncInfo} from "@atomiqlabs/base";
import http2Express from "http2-express-bridge";
import * as express from "express";
import * as cors from "cors";
import {generateAlpnChallengeCert, LetsEncryptACME} from "../LetsEncryptACME";
import * as tls from "node:tls";
import {EventEmitter} from "node:events";
import {fromDecimal} from "@atomiqlabs/server-base";
import {HttpRateLimiter} from "../http/HttpRateLimiter";
import {ConnectionRateLimiter} from "../http/ConnectionRateLimiter";
import {createBodySizeLimiter} from "../http/BodySizeLimiter";
import {SecureContext} from "node:tls";
import {logger} from "starknet";
import {KeyBasedWhitelist} from "../http/KeyBasedWhitelist";

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
    RECOVER_SPV_VAULTS="recover_spv_vaults",
    READY="ready"
}

function removeAllowedAssets(handler: SwapHandler<any>, assets: string[]) {
    if(assets==null) return;
    assets.forEach(val => {
        const arr = val.split("-");
        if(arr.length===1) {
            //Also allow blacklisting of all assets for a given chain
            const chain = arr[0];
            const handlerAssetSet = handler.allowedTokens[chain];
            if(handlerAssetSet==null) return;
            handlerAssetSet.clear();
        } else {
            if(arr.length!=2) return;
            const [chain, asset] = arr;
            const assetData = IntermediaryConfig.ASSETS[asset];
            if(assetData==null) return;
            const address = assetData.chains[chain]?.address;
            if(address==null) return;
            const handlerAssetSet = handler.allowedTokens[chain];
            if(handlerAssetSet==null) return;
            handlerAssetSet.delete(address);
        }
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

    readonly minChainBalanceReserves: {[chainId: string]: bigint};

    initState: IntermediaryInitState = IntermediaryInitState.STARTING;
    sslAutoUrl: string;

    keyBasedWhitelist: KeyBasedWhitelist;

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
        spvVaultSigner: ISpvVaultSigner,
        minChainBalanceReserves: {[chainId: string]: bigint},
        keyBasedWhitelist: KeyBasedWhitelist
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
        this.minChainBalanceReserves = minChainBalanceReserves;
        this.keyBasedWhitelist = keyBasedWhitelist;
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
            securityDepositAPY: Number(IntermediaryConfig.SECURITY_DEPOSIT_APY ?? IntermediaryConfig.SOLANA.SECURITY_DEPOSIT_APY)/1000000,
            minNativeBalances: this.minChainBalanceReserves
        };

        const toBtcConfig = IntermediaryConfig.TO_BTC ?? IntermediaryConfig.ONCHAIN;
        if(toBtcConfig!=null) {
            const tobtc = new ToBtcAbs(
                new IntermediaryStorageManager(this.directory + "/tobtc"),
                "/tobtc",
                this.multichainData,
                this.bitcoinWallet,
                this.prices,
                this.bitcoinRpc,
                {
                    ...globalConfig,
                    baseFee: toBtcConfig.BASE_FEE,
                    feePPM: toBtcConfig.FEE_PERCENTAGE,
                    maxInflightSwaps: toBtcConfig.MAX_INFLIGHT_SWAPS,
                    sendSafetyFactor: CHAIN_SEND_SAFETY_FACTOR,

                    minChainCltv: 10n,

                    networkFeeMultiplier: 1+(toBtcConfig.NETWORK_FEE_ADD_PERCENTAGE/100),
                    minConfirmations: 1,
                    maxConfirmations: 6,
                    maxConfTarget: 12,
                    minConfTarget: 1,

                    txCheckInterval: 10 * 1000,

                    max: (toBtcConfig as any).MAX_TO_BTC ?? toBtcConfig.MAX,
                    min: (toBtcConfig as any).MIN_TO_BTC ?? toBtcConfig.MIN,

                    minMaxOverrides: (toBtcConfig as any).MIN_MAX_OVERRIDES_TO_BTC ?? (toBtcConfig as any).MIN_MAX_OVERRIDES
                }
            );
            removeAllowedAssets(tobtc, toBtcConfig.EXCLUDE_ASSETS);
            this.swapHandlers.push(tobtc);
        }

        const fromBtcConfig = IntermediaryConfig.FROM_BTC ?? IntermediaryConfig.ONCHAIN;
        if(fromBtcConfig!=null && (fromBtcConfig as any).LEGACY_SWAPS!=="disable") {
            const frombtc = new FromBtcAbs(
                new IntermediaryStorageManager(this.directory + "/frombtc"),
                "/frombtc",
                this.multichainData,
                this.bitcoinWallet,
                this.prices,
                {
                    ...globalConfig,
                    baseFee: fromBtcConfig.BASE_FEE,
                    feePPM: fromBtcConfig.FEE_PERCENTAGE,
                    maxInflightSwaps: fromBtcConfig.MAX_INFLIGHT_SWAPS,

                    confirmations: 2,
                    swapCsvDelta: 72,

                    max: (fromBtcConfig as any).MAX_FROM_BTC ?? fromBtcConfig.MAX,
                    min: (fromBtcConfig as any).MIN_FROM_BTC ?? fromBtcConfig.MIN,

                    minMaxOverrides: (fromBtcConfig as any).MIN_MAX_OVERRIDES_FROM_BTC ?? (fromBtcConfig as any).MIN_MAX_OVERRIDES
                }
            );
            removeAllowedAssets(frombtc, fromBtcConfig.EXCLUDE_ASSETS);
            const legacySwapHandling: "enable" | "legacy_chains_only" | "disable" | undefined = (fromBtcConfig as any).LEGACY_SWAPS;
            if(legacySwapHandling==="legacy_chains_only") {
                for(let chain in frombtc.allowedTokens) {
                    //If the given chain supports the newer swap protocol, use only that
                    if(this.multichainData.chains[chain].spvVaultContract!=null)
                        frombtc.allowedTokens[chain].clear();
                }
            }
            this.swapHandlers.push(frombtc);
        }

        const fromBtcSpvConfig = IntermediaryConfig.FROM_BTC ?? IntermediaryConfig.ONCHAIN_SPV;
        if(fromBtcSpvConfig!=null && this.spvVaultSigner!=null) {
            const gasTokenMax = {};
            for(let chainId in fromBtcSpvConfig.GAS_MAX) {
                if(fromBtcSpvConfig.GAS_MAX[chainId]==null) continue;
                if(this.multichainData.chains[chainId]==null) continue;
                const tokenData = this.prices.getTokenData(this.multichainData.chains[chainId].chainInterface.getNativeCurrencyAddress(), chainId);
                gasTokenMax[chainId] = fromDecimal(fromBtcSpvConfig.GAS_MAX[chainId].toFixed(tokenData.decimals), tokenData.decimals);
            }

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
                    baseFee: fromBtcSpvConfig.BASE_FEE,
                    feePPM: fromBtcSpvConfig.FEE_PERCENTAGE,
                    max: fromBtcSpvConfig.MAX,
                    min: fromBtcSpvConfig.MIN,
                    minMaxOverrides: fromBtcSpvConfig.MIN_MAX_OVERRIDES,
                    gasTokenMax,
                    maxInflightSwaps: fromBtcSpvConfig.MAX_INFLIGHT_SWAPS,

                    vaultsCheckInterval: 60*1000,
                    maxUnclaimedWithdrawals: 5
                },
                new StorageManager(this.directory+"/frombtc_spv_sticky_addresses")
            );
            removeAllowedAssets(this.spvSwapHandler, fromBtcSpvConfig.EXCLUDE_ASSETS);
            for(let chain in this.spvSwapHandler.allowedTokens) {
                //If the given chain doesn't support the newer swap protocol, remove that chain's tokens
                if(this.multichainData.chains[chain].spvVaultContract==null)
                    this.spvSwapHandler.allowedTokens[chain].clear();
            }
            this.swapHandlers.push(this.spvSwapHandler);
        }

        const toBtcLnConfig = IntermediaryConfig.TO_BTCLN ?? IntermediaryConfig.LN;
        if(toBtcLnConfig!=null) {
            const tobtcln = new ToBtcLnAbs(
                new IntermediaryStorageManager(this.directory+"/tobtcln"),
                "/tobtcln",
                this.multichainData,
                this.lightningWallet,
                this.prices,
                {
                    ...globalConfig,
                    baseFee: toBtcLnConfig.BASE_FEE,
                    feePPM: toBtcLnConfig.FEE_PERCENTAGE,
                    max: toBtcLnConfig.MAX,
                    min: toBtcLnConfig.MIN,
                    minMaxOverrides: toBtcLnConfig.MIN_MAX_OVERRIDES,

                    routingFeeMultiplier: 2n,

                    minSendCltv: 10n,

                    allowShortExpiry: toBtcLnConfig.ALLOW_LN_SHORT_EXPIRY,
                    allowProbeFailedSwaps: toBtcLnConfig.ALLOW_NON_PROBABLE_SWAPS,
                    maxInflightSwaps: toBtcLnConfig.MAX_INFLIGHT_SWAPS,

                    lnSendBitcoinBlockTimeSafetyFactorPPM: LN_SAFETY_FACTOR_OVERRIDE_PPM
                }
            );
            removeAllowedAssets(tobtcln, toBtcLnConfig.EXCLUDE_ASSETS);
            this.swapHandlers.push(tobtcln);
        }

        const fromBtcLnConfig = IntermediaryConfig.FROM_BTCLN ?? IntermediaryConfig.LN;
        if(fromBtcLnConfig!=null && (fromBtcLnConfig as any).LEGACY_SWAPS!=="disable") {
            const frombtcln = new FromBtcLnAbs(
                new IntermediaryStorageManager(this.directory+"/frombtcln"),
                "/frombtcln",
                this.multichainData,
                this.lightningWallet,
                this.prices,
                {
                    ...globalConfig,
                    baseFee: fromBtcLnConfig.BASE_FEE,
                    feePPM: fromBtcLnConfig.FEE_PERCENTAGE,
                    max: fromBtcLnConfig.MAX,
                    min: fromBtcLnConfig.MIN,
                    minMaxOverrides: fromBtcLnConfig.MIN_MAX_OVERRIDES,

                    minCltv: 20n,

                    swapCheckInterval: 1*60*1000,
                    invoiceTimeoutSeconds: fromBtcLnConfig.INVOICE_EXPIRY_SECONDS,
                    maxInflightSwaps: fromBtcLnConfig.MAX_INFLIGHT_SWAPS
                }
            );
            removeAllowedAssets(frombtcln, fromBtcLnConfig.EXCLUDE_ASSETS);
            const legacySwapHandling: "enable" | "legacy_chains_only" | "disable" | undefined = (fromBtcLnConfig as any).LEGACY_SWAPS;
            if(legacySwapHandling==="legacy_chains_only") {
                for(let chain in frombtcln.allowedTokens) {
                    //If the contract supports the new auto-swap way, use only that
                    if(this.multichainData.chains[chain].swapContract.supportsInitWithoutClaimer)
                        frombtcln.allowedTokens[chain].clear();
                }
            }
            this.swapHandlers.push(frombtcln);
        }

        if(fromBtcLnConfig!=null) {
            const gasTokenMax = {};
            for(let chainId in fromBtcLnConfig.GAS_MAX) {
                if(fromBtcLnConfig.GAS_MAX[chainId]==null) continue;
                if(this.multichainData.chains[chainId]==null) continue;
                const tokenData = this.prices.getTokenData(this.multichainData.chains[chainId].chainInterface.getNativeCurrencyAddress(), chainId);
                gasTokenMax[chainId] = fromDecimal(fromBtcLnConfig.GAS_MAX[chainId].toFixed(tokenData.decimals), tokenData.decimals);
            }

            const frombtclnAuto = new FromBtcLnAuto(
                new IntermediaryStorageManager(this.directory+"/frombtcln_auto"),
                "/frombtcln_auto",
                this.multichainData,
                this.lightningWallet,
                this.prices,
                {
                    ...globalConfig,
                    baseFee: fromBtcLnConfig.BASE_FEE,
                    feePPM: fromBtcLnConfig.FEE_PERCENTAGE,
                    max: fromBtcLnConfig.MAX,
                    min: fromBtcLnConfig.MIN,
                    minMaxOverrides: fromBtcLnConfig.MIN_MAX_OVERRIDES,

                    minCltv: 20n,

                    swapCheckInterval: 1*60*1000,
                    invoiceTimeoutSeconds: fromBtcLnConfig.INVOICE_EXPIRY_SECONDS,
                    gasTokenMax,
                    maxInflightSwaps: fromBtcLnConfig.MAX_INFLIGHT_AUTO_SWAPS ?? fromBtcLnConfig.MAX_INFLIGHT_SWAPS
                }
            );
            removeAllowedAssets(frombtclnAuto, fromBtcLnConfig.EXCLUDE_ASSETS);
            for(let chain in frombtclnAuto.allowedTokens) {
                //If the given chain doesn't support the newer swap protocol, remove that chain's tokens
                if(!this.multichainData.chains[chain].swapContract.supportsInitWithoutClaimer)
                    frombtclnAuto.allowedTokens[chain].clear();
            }
            this.swapHandlers.push(frombtclnAuto);
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
                        recommendFeeMultiplier: 1,

                        maxInflightSwaps: IntermediaryConfig.ONCHAIN_TRUSTED.MAX_INFLIGHT_SWAPS
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
                        invoiceTimeoutSeconds: IntermediaryConfig.LN_TRUSTED.INVOICE_EXPIRY_SECONDS,

                        maxInflightSwaps: IntermediaryConfig.LN_TRUSTED.MAX_INFLIGHT_SWAPS
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
        if(this.keyBasedWhitelist!=null) this.keyBasedWhitelist.start();

        const useSsl = IntermediaryConfig.SSL!=null || IntermediaryConfig.SSL_AUTO!=null;

        const listenPort = IntermediaryConfig.REST.PORT;

        const httpRateLimiter = new HttpRateLimiter(IntermediaryConfig.REST.REQUEST_LIMIT?.LIMIT, IntermediaryConfig.REST.REQUEST_LIMIT?.WINDOW_MS);
        httpRateLimiter.start();
        const concurrentRequestLimiter = new ConnectionRateLimiter(IntermediaryConfig.REST.CONNECTION_LIMIT);

        const restServer = http2Express(express) as express.Express;
        restServer.use(createBodySizeLimiter(8*1024));
        if(this.keyBasedWhitelist!=null) restServer.use(this.keyBasedWhitelist.getMiddleware());
        restServer.use(httpRateLimiter.getPreMiddleware());
        restServer.use(concurrentRequestLimiter.getPreMiddleware());
        restServer.use(httpRateLimiter.getPostMiddleware());
        restServer.use(concurrentRequestLimiter.getPostMiddleware());
        restServer.use(cors({
            maxAge: 24*60*60*1000
        }));

        for(let swapHandler of this.swapHandlers) {
            swapHandler.startRestServer(restServer);
        }
        this.infoHandler.startRestServer(restServer);

        await PluginManager.onHttpServerStarted(restServer);

        const mappedSecureContexts: Map<string, SecureContext> = new Map();
        let defaultSecureContext: SecureContext;

        let server: http2.Http2Server | http2.Http2SecureServer;
        if(!useSsl) {
            server = http2.createServer(restServer);
        } else {
            server = http2.createSecureServer({
                allowHTTP1: true,
                ALPNCallback: IntermediaryConfig.SSL_AUTO?.ACME_METHOD==="tls-alpn-01" ? ({servername, protocols}) => {
                    // console.log(`[IntermediaryRunner: TLS]: ALPNCallback: Request servername: ${servername}, protocols: ${protocols.join(", ")}`);
                    if(protocols.includes("acme-tls/1")) return "acme-tls/1";
                    if(protocols.includes("h2")) return "h2";
                    if(protocols.includes("http/1.1")) return "http/1.1";
                    return undefined;
                } : undefined,
                SNICallback: (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => {
                    // console.log(`[IntermediaryRunner: TLS]: SNICallback: Request servername: ${servername}`);
                    const secureContextToUse = mappedSecureContexts.get(servername);
                    if(secureContextToUse!=null) {
                        cb(null, secureContextToUse);
                        return;
                    }
                    cb(null, defaultSecureContext);
                }
            }, restServer);
        }

        server.setTimeout(IntermediaryConfig.REST.CONNECTION_TIMEOUT_MS ?? 2 * 60 * 1000);

        await new Promise<void>((resolve, reject) => {
            server.on("error", e => reject(e));
            server.listen(listenPort, IntermediaryConfig.REST.ADDRESS, () => resolve());
        });

        console.log("[Main]: Rest server listening on port: "+listenPort+" ssl: "+useSsl);

        const renewCallback = (_key: Buffer, _cert: Buffer) => {
            defaultSecureContext = tls.createSecureContext({
                key: _key,
                cert: _cert,
            });
        }

        if(IntermediaryConfig.SSL_AUTO!=null) {
            console.log("[Main]: Using automatic SSL cert provision through Let's Encrypt & dns proxy: "+IntermediaryConfig.SSL_AUTO.DNS_PROXY);

            let dnsNames: string[];

            if(IntermediaryConfig.SSL_AUTO.FULL_DNS_DOMAIN!=null) {
                dnsNames = IntermediaryConfig.SSL_AUTO.FULL_DNS_DOMAIN.split(",");
            } else {let address: string;
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

                const ipWithDashes = address.replace(new RegExp("\\.", 'g'), "-");
                dnsNames = IntermediaryConfig.SSL_AUTO.DNS_PROXY.split(",").map(domain => ipWithDashes.split(",").map(ip => ip+"."+domain)).flat();
            }

            console.log("[Main]: Domain name: "+dnsNames.join(", "));

            const dir = this.directory+"/ssl";
            try {
                await fs.mkdir(dir);
            } catch (e) {}
            const acme = new LetsEncryptACME(dnsNames, dir+"/key.pem", dir+"/cert.pem", {
                challengeType: IntermediaryConfig.SSL_AUTO.ACME_METHOD ?? "http-01",
                httpListenPort: IntermediaryConfig.SSL_AUTO.HTTP_LISTEN_PORT,
                httpListenAddress: IntermediaryConfig.SSL_AUTO.HTTP_LISTEN_ADDRESS,
                addAlpnChallenge: (domain, secureContext) => mappedSecureContexts.set(domain, secureContext),
                removeAlpnChallenge: (domain) => mappedSecureContexts.delete(domain)
            });

            const url = "https://"+dnsNames[0]+":"+listenPort;
            this.sslAutoUrl = url;
            await fs.writeFile(this.directory+"/url.txt", url);

            await acme.init(renewCallback);
        }
        if(IntermediaryConfig.SSL!=null) {
            console.log("[Main]: Using existing SSL certs");

            renewCallback(await fs.readFile(IntermediaryConfig.SSL.KEY_FILE), await fs.readFile(IntermediaryConfig.SSL.CERT_FILE));

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
    }

    async tryRecoverSpvVaults() {
        if(this.spvSwapHandler==null) return;
        if(this.spvSwapHandler.Vaults.recoverVaults==null) return;

        for(let chainId in this.multichainData.chains) {
            try {
                await fs.readFile(this.directory+"/"+chainId+"-vaults-recovered-at.txt");
            } catch (e) {
                const knownVaults = await this.spvSwapHandler.Vaults.listVaults(chainId);
                if(knownVaults.length!==0) continue;

                logger.info(`init(): Recovering SPV vaults for ${chainId}...`);
                this.setState(IntermediaryInitState.RECOVER_SPV_VAULTS);
                try {
                    const timeOfRecovery = Date.now();
                    const vaults = await this.spvSwapHandler.Vaults.recoverVaults(chainId);
                    logger.info(`init(): Successfully recovered ${vaults.length} SPV vaults on ${chainId}!`);
                    await fs.writeFile(this.directory+"/"+chainId+"-vaults-recovered-at.txt", timeOfRecovery.toString(10));
                } catch (e) {
                    logger.error(`init(): Failed to recover SPV vault for ${chainId} (will be automatically retried on next startup): `, e);
                }
            }
        }
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

        for(let chainId in this.multichainData.chains) {
            const {signer} = this.multichainData.chains[chainId];
            if(signer.init!=null) await signer.init();
        }
        console.log("[Main]: Signers initialized!");

        this.setState(IntermediaryInitState.INIT_HANDLERS);
        await this.initSwapHandlers();

        console.log("[Main]: Swap handlers initialized!");

        this.setState(IntermediaryInitState.INIT_EVENTS);
        for(let chainId in this.multichainData.chains) {
            const chainData = this.multichainData.chains[chainId];
            await chainData.swapContract.start();
            try {
                if(chainData.swapContract.claimDeposits!=null) await chainData.swapContract.claimDeposits(chainData.signer, {waitForConfirmation: true});
            } catch (e) {
                console.error(`[Main]: Failed to claim deposits for ${chainId}: `, e);
            }
            await chainData.chainEvents.init();
        }

        console.log("[Main]: Chain events synchronized!");

        this.setState(IntermediaryInitState.INIT_WATCHDOGS);
        await this.startHandlerWatchdogs();

        console.log("[Main]: Watchdogs started!");

        this.setState(IntermediaryInitState.START_REST);
        await this.startRestServer();

        await this.tryRecoverSpvVaults();

        this.setState(IntermediaryInitState.READY);
    }

}