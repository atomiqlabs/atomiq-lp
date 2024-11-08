import {getEnabledPlugins} from "../plugins";
import {getAuthenticatedLndGrpc, getUnauthenticatedLndGrpc, LND_MNEMONIC_FILE} from "../btc/LND";
import {
    AUTHORIZATION_TIMEOUT,
    BITCOIN_BLOCKTIME, BITCOIN_NETWORK, CHAIN_SEND_SAFETY_FACTOR,
    GRACE_PERIOD,
    MAX_SOL_SKEW,
    SAFETY_FACTOR
} from "../constants/Constants";
import {IntermediaryConfig} from "../IntermediaryConfig";
import * as BN from "bn.js";
import * as http2 from "http2";
import * as fs from "fs/promises";
import {
    FromBtcAbs,
    FromBtcLnAbs,
    IBtcFeeEstimator,
    InfoHandler,
    IntermediaryStorageManager,
    ISwapPrice, MultichainData,
    OneDollarFeeEstimator,
    PluginManager,
    SwapHandler,
    SwapHandlerSwap,
    ToBtcAbs,
    ToBtcLnAbs
} from "crosslightning-intermediary";
import {BitcoinRpc, BtcSyncInfo, SwapData} from "crosslightning-base";
import http2Express from "http2-express-bridge";
import * as express from "express";
import * as cors from "cors";
import {AuthenticatedLnd, UnauthenticatedLnd} from "lightning";
import * as lncli from "ln-service";
import {LetsEncryptACME} from "../LetsEncryptACME";
import * as tls from "node:tls";
import {EventEmitter} from "node:events";

export enum IntermediaryInitState {
    STARTING="starting",
    WAIT_BTC_RPC="wait_btc_rpc",
    WAIT_LND_WALLET="wait_lnd_wallet",
    WAIT_LND_SYNC="wait_lnd_sync",
    CONTRACT_INIT="wait_contract_init",
    LOAD_PLUGINS="load_plugins",
    REGISTER_HANDLERS="register_handlers",
    INIT_HANDLERS="init_handlers",
    INIT_EVENTS="init_events",
    INIT_WATCHDOGS="init_watchdogs",
    START_REST="start_rest",
    READY="ready"
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
    readonly bitcoinRpc: BitcoinRpc<any>;
    readonly multichainData: MultichainData;

    readonly swapHandlers: SwapHandler<SwapHandlerSwap>[] = [];
    btcFeeEstimator: IBtcFeeEstimator;
    infoHandler: InfoHandler;
    LND: AuthenticatedLnd;

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
    ) {
        super();
        this.directory = directory;
        this.multichainData = multichainData;
        this.tokens = tokens;
        this.prices = prices;
        this.bitcoinRpc = bitcoinRpc;
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

    async getLNDWalletStatus(lnd: UnauthenticatedLnd): Promise<"offline" | "ready" | "active" | "waiting" | "starting" | "absent" | "locked"> {
        let walletStatus = null;
        try {
            walletStatus = await lncli.getWalletStatus({lnd});
        } catch (e) {
            console.error(e);
            return "offline";
        }
        if (walletStatus.is_absent) return "absent";
        if (walletStatus.is_active) return "active";
        if (walletStatus.is_locked) return "locked";
        if (walletStatus.is_ready) return "ready";
        if (walletStatus.is_starting) return "starting";
        if (walletStatus.is_waiting) return "waiting";
    }


    private createLNDWallet(lnd: UnauthenticatedLnd, mnemonic: string, password: string): Promise<{
        macaroon: string
    }> {
        return new Promise<{
            macaroon: string
        }>((resolve, reject) => {
            lnd.unlocker.initWallet({
                aezeed_passphrase: undefined,
                cipher_seed_mnemonic: mnemonic.split(' '),
                wallet_password: Buffer.from(password, "utf8"),
                recovery_window: 1000
            }, (err, res) => {
                if (!!err) {
                    reject([503, 'UnexpectedInitWalletError', {err}]);
                    return;
                }

                if (!res) {
                    reject([503, 'ExpectedResponseForInitWallet']);
                    return;
                }

                if (!Buffer.isBuffer(res.admin_macaroon)) {
                    reject([503, 'ExpectedAdminMacaroonToCrateWallet']);
                    return;
                }

                resolve({
                    macaroon: res.admin_macaroon.toString("base64")
                });
            });
        });
    }

    async tryConnectLNDWallet(): Promise<boolean> {
        let lnd: UnauthenticatedLnd;
        try {
            lnd = getUnauthenticatedLndGrpc();
        } catch (e) {
            console.error(e);
            return false;
        }

        const walletStatus = await this.getLNDWalletStatus(lnd);

        console.log("[Main] LND wallet status: "+walletStatus);

        if(walletStatus==="active" || walletStatus==="ready") return true;
        if(walletStatus==="waiting" || walletStatus==="starting" || walletStatus==="offline") return false;
        if(walletStatus==="absent") {
            //Create a new wallet based on the the seed in LND mnemonic file config
            if(LND_MNEMONIC_FILE==null || IntermediaryConfig.LND.WALLET_PASSWORD_FILE==null) {
                throw new Error("Error initializing LND, no mnemonic and/or wallet password provided!");
            }
            let mnemonic: string;
            let password: string;
            try {
                const result = await fs.readFile(LND_MNEMONIC_FILE);
                mnemonic = result.toString();
                const resultPass = await fs.readFile(IntermediaryConfig.LND.WALLET_PASSWORD_FILE);
                password = resultPass.toString();
            } catch (e) {
                console.error(e);
            }
            if(mnemonic==null) {
                throw new Error("Invalid LND mnemonic file provided!");
            }
            if(password==null) {
                throw new Error("Invalid LND wallet password file provided!");
            }
            await this.createLNDWallet(lnd, mnemonic, password);
            return false;
        }
        if(walletStatus==="locked") {
            if(IntermediaryConfig.LND.WALLET_PASSWORD_FILE==null) {
                throw new Error("Error initializing LND, no wallet password provided!");
            }
            let password: string;
            try {
                const resultPass = await fs.readFile(IntermediaryConfig.LND.WALLET_PASSWORD_FILE);
                password = resultPass.toString();
            } catch (e) {
                console.error(e);
            }
            if(password==null) {
                throw new Error("Invalid LND wallet password file provided!");
            }
            await lncli.unlockWallet({
                lnd,
                password
            });
            return false;
        }

    }

    /**
     * Checks if LND wallet is unlocked and ready to roll
     */
    async waitForLNDWallet() {
        console.log("[Main] Waiting for LND wallet initialization...");
        let lndReady: boolean = false;
        while(!lndReady) {
            lndReady = await this.tryConnectLNDWallet();
            if(!lndReady) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("[Main] LND wallet ready, continue!");
    }

    async isLNDSynced() {
        const resp = await lncli.getWalletInfo({
            lnd: this.LND
        });
        console.log("[Main] LND blockheight: "+resp.current_block_height+" is_synced: "+resp.is_synced_to_chain);
        return resp.is_synced_to_chain;
    }

    /**
     * Checks if LND node is synchronized and ready
     */
    async waitForLNDSync() {
        console.log("[Main] Waiting for LND node synchronization...");
        let lndReady: boolean = false;
        while(!lndReady) {
            lndReady = await this.isLNDSynced();
            if(!lndReady) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("[Main] LND node ready, continue!");
    }

    async registerPlugins(): Promise<void> {
        const tokenData: {
            [ticker: string]: {
                [chainId: string]: {
                    address: string,
                    decimals: number
                }
            }
        } = {};
        for(let ticker in this.tokens) {
            tokenData[ticker] = this.tokens[ticker].chains;
        }
        const plugins = await getEnabledPlugins();
        plugins.forEach(pluginData => PluginManager.registerPlugin(pluginData.name, pluginData.plugin));
        await PluginManager.enable(
            this.multichainData,
            this.bitcoinRpc,
            this.LND,
            this.prices,
            tokenData,
            process.env.PLUGINS_DIR
        );
    }

    registerSwapHandlers(): void {

        this.btcFeeEstimator = new OneDollarFeeEstimator(
            IntermediaryConfig.BITCOIND.HOST,
            IntermediaryConfig.BITCOIND.PORT,
            IntermediaryConfig.BITCOIND.RPC_USERNAME,
            IntermediaryConfig.BITCOIND.RPC_PASSWORD,
            IntermediaryConfig.ONCHAIN?.ADD_NETWORK_FEE,
            IntermediaryConfig.ONCHAIN?.MULTIPLY_NETWORK_FEE
        );

        if(IntermediaryConfig.ONCHAIN!=null) {
            this.swapHandlers.push(
                new ToBtcAbs(new IntermediaryStorageManager(this.directory + "/tobtc"), "/tobtc", this.multichainData, this.LND, this.prices, this.bitcoinRpc, {
                    authorizationTimeout: AUTHORIZATION_TIMEOUT,
                    bitcoinBlocktime: BITCOIN_BLOCKTIME,
                    gracePeriod: GRACE_PERIOD,
                    baseFee: IntermediaryConfig.ONCHAIN.BASE_FEE,
                    feePPM: IntermediaryConfig.ONCHAIN.FEE_PERCENTAGE,
                    max: IntermediaryConfig.ONCHAIN.MAX,
                    min: IntermediaryConfig.ONCHAIN.MIN,
                    maxSkew: MAX_SOL_SKEW,
                    safetyFactor: SAFETY_FACTOR,
                    sendSafetyFactor: CHAIN_SEND_SAFETY_FACTOR,

                    bitcoinNetwork: BITCOIN_NETWORK,

                    minChainCltv: new BN(10),

                    networkFeeMultiplierPPM: new BN(1000000).add(IntermediaryConfig.ONCHAIN.NETWORK_FEE_ADD_PERCENTAGE),
                    minConfirmations: 1,
                    maxConfirmations: 6,
                    maxConfTarget: 12,
                    minConfTarget: 1,

                    txCheckInterval: 10 * 1000,
                    swapCheckInterval: 5 * 60 * 1000,

                    feeEstimator: this.btcFeeEstimator
                })
            );
            this.swapHandlers.push(
                new FromBtcAbs(new IntermediaryStorageManager(this.directory + "/frombtc"), "/frombtc", this.multichainData, this.LND, this.prices, {
                    authorizationTimeout: AUTHORIZATION_TIMEOUT,
                    bitcoinBlocktime: BITCOIN_BLOCKTIME,
                    baseFee: IntermediaryConfig.ONCHAIN.BASE_FEE,
                    feePPM: IntermediaryConfig.ONCHAIN.FEE_PERCENTAGE,
                    max: IntermediaryConfig.ONCHAIN.MAX,
                    min: IntermediaryConfig.ONCHAIN.MIN,
                    maxSkew: MAX_SOL_SKEW,
                    safetyFactor: SAFETY_FACTOR,

                    bitcoinNetwork: BITCOIN_NETWORK,

                    confirmations: 2,
                    swapCsvDelta: 72,

                    swapCheckInterval: 5 * 60 * 1000,
                    securityDepositAPY: IntermediaryConfig.SOLANA.SECURITY_DEPOSIT_APY.toNumber() / 1000000
                })
            );
        }

        if(IntermediaryConfig.LN!=null) {
            this.swapHandlers.push(
                new ToBtcLnAbs(new IntermediaryStorageManager(this.directory+"/tobtcln"), "/tobtcln", this.multichainData, this.LND, this.prices, {
                    authorizationTimeout: AUTHORIZATION_TIMEOUT,
                    bitcoinBlocktime: BITCOIN_BLOCKTIME,
                    gracePeriod: GRACE_PERIOD,
                    baseFee: IntermediaryConfig.LN.BASE_FEE,
                    feePPM: IntermediaryConfig.LN.FEE_PERCENTAGE,
                    max: IntermediaryConfig.LN.MAX,
                    min: IntermediaryConfig.LN.MIN,
                    maxSkew: MAX_SOL_SKEW,
                    safetyFactor: SAFETY_FACTOR,

                    routingFeeMultiplier: new BN(2),

                    minSendCltv: new BN(10),

                    swapCheckInterval: 5*60*1000,

                    allowShortExpiry: IntermediaryConfig.LN.ALLOW_LN_SHORT_EXPIRY,
                    allowProbeFailedSwaps: IntermediaryConfig.LN.ALLOW_NON_PROBABLE_SWAPS
                })
            );
            this.swapHandlers.push(
                new FromBtcLnAbs(new IntermediaryStorageManager(this.directory+"/frombtcln"), "/frombtcln", this.multichainData, this.LND, this.prices, {
                    authorizationTimeout: AUTHORIZATION_TIMEOUT,
                    bitcoinBlocktime: BITCOIN_BLOCKTIME,
                    gracePeriod: GRACE_PERIOD,
                    baseFee: IntermediaryConfig.LN.BASE_FEE,
                    feePPM: IntermediaryConfig.LN.FEE_PERCENTAGE,
                    max: IntermediaryConfig.LN.MAX,
                    min: IntermediaryConfig.LN.MIN,
                    maxSkew: MAX_SOL_SKEW,
                    safetyFactor: SAFETY_FACTOR,

                    minCltv: new BN(20),

                    swapCheckInterval: 1*60*1000,
                    securityDepositAPY: IntermediaryConfig.SOLANA.SECURITY_DEPOSIT_APY.toNumber()/1000000
                })
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
            const dns = ipWithDashes+"."+IntermediaryConfig.SSL_AUTO.DNS_PROXY;
            console.log("[Main]: Domain name: "+dns);
            const acme = new LetsEncryptACME(dns, dir+"/key.pem", dir+"/cert.pem", IntermediaryConfig.SSL_AUTO.HTTP_LISTEN_PORT);

            const url = "https://"+dns+":"+listenPort;
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
                            renewCallback(await fs.readFile(IntermediaryConfig.SSL.KEY_FILE), cert);
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
                            renewCallback(key, await fs.readFile(IntermediaryConfig.SSL.CERT_FILE));
                        } catch (e) {
                            console.log("SSL CERT watcher error: ", e);
                            console.error(e);
                        }
                    }
                }
            })();
        }

        const restServer = http2Express(express);
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

        await new Promise<void>((resolve, reject) => {
            server.on("error", e => reject(e));
            server.listen(listenPort, IntermediaryConfig.REST.ADDRESS, () => resolve());
        });

        console.log("[Main]: Rest server listening on port: "+listenPort+" ssl: "+useSsl);
    }

    async init() {
        this.setState(IntermediaryInitState.WAIT_BTC_RPC);
        await this.waitForBitcoinRpc();
        this.setState(IntermediaryInitState.WAIT_LND_WALLET);
        await this.waitForLNDWallet();
        this.setState(IntermediaryInitState.WAIT_LND_SYNC);
        this.LND = getAuthenticatedLndGrpc();
        await this.waitForLNDSync();

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
            await this.multichainData.chains[chainId].chainEvents.init();
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