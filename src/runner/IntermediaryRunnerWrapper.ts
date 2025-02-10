import {BitcoinRpc, ChainSwapType} from "@atomiqlabs/base";
import {
    FromBtcLnSwapAbs,
    FromBtcLnSwapState,
    FromBtcSwapAbs,
    FromBtcSwapState, IBitcoinWallet, ILightningWallet,
    ISwapPrice, MultichainData,
    PluginManager,
    SwapHandlerType,
    ToBtcLnSwapAbs,
    ToBtcLnSwapState,
    ToBtcSwapAbs,
    ToBtcSwapState
} from "@atomiqlabs/lp-lib";
import {IntermediaryRunner} from "./IntermediaryRunner";
import * as BN from "bn.js";
import {
    cmdEnumParser,
    cmdNumberParser,
    cmdStringParser,
    CommandHandler,
    createCommand
} from "@atomiqlabs/server-base";
import {fromDecimal, toDecimal} from "../Utils";
import {IntermediaryConfig} from "../IntermediaryConfig";
import {Registry} from "../Registry";
import * as bolt11 from "@atomiqlabs/bolt11";

export class IntermediaryRunnerWrapper extends IntermediaryRunner {

    cmdHandler: CommandHandler;
    lpRegistry: Registry;
    addressesToTokens: {
        [chainId: string]: {
            [address: string]: {
                ticker: string,
                decimals: number
            }
        }
    };

    fromReadableToken(txt: string) {
        const arr = txt.split("-");
        if(arr.length>1) {
            return {ticker: txt.substring(arr[0].length+1), chainId: arr[0]}
        } else {
            return {ticker: txt, chainId: this.multichainData.default};
        }
    }

    toReadableToken(chainId: string, ticker: string) {
        return chainId+"-"+ticker;
    }

    constructor(
        directory: string,
        multichainData: MultichainData,
        tokens: {
            [ticker: string]: {
                chains: {
                    [chainIdentifier: string] : {
                        address: string,
                        decimals: number
                    }
                },
                pricing: string,
                disabled?: boolean
            }
        },
        prices: ISwapPrice<any>,
        bitcoinRpc: BitcoinRpc<any>,
        bitcoinWallet: IBitcoinWallet,
        lightningWallet: ILightningWallet
    ) {
        super(directory, multichainData, tokens, prices, bitcoinRpc, bitcoinWallet, lightningWallet);
        this.lpRegistry = new Registry(directory+"/lpRegistration.txt");
        this.addressesToTokens = {};
        const tokenTickers = [];
        for(let ticker in this.tokens) {
            for(let chainId in this.tokens[ticker].chains) {
                if(this.addressesToTokens[chainId]==null) this.addressesToTokens[chainId] = {};
                const tokenData = this.tokens[ticker].chains[chainId];
                this.addressesToTokens[chainId][tokenData.address] = {
                    decimals: tokenData.decimals,
                    ticker
                };
                tokenTickers.push(this.toReadableToken(chainId, ticker));
            }
        }
        const commands = [
            createCommand(
                "status",
                "Fetches the current status of the bitcoin RPC, LND gRPC & intermediary application",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];

                        reply.push("SmartChains status:");
                        for(let chainId in this.multichainData.chains) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            const nativeTokenAddress = swapContract.getNativeCurrencyAddress();
                            const {decimals, ticker} = this.addressesToTokens[chainId][nativeTokenAddress.toString()];
                            let nativeTokenBalance: BN;
                            try {
                                nativeTokenBalance = await swapContract.getBalance(signer.getAddress(), nativeTokenAddress, false);
                            } catch (e) {
                                console.error(e);
                            }
                            reply.push("    "+chainId+":");
                            reply.push("        RPC status: "+(nativeTokenBalance!=null ? "ready" : "offline!"));
                            if(nativeTokenBalance!=null) {
                                reply.push("        Funds: " + toDecimal(nativeTokenBalance, decimals)+" "+ticker);
                                reply.push("        Has enough funds (>0.1): " + (nativeTokenBalance.gt(new BN(100000000)) ? "yes" : "no"));
                            }
                        }

                        if(this.bitcoinRpc!=null) {
                            const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);
                            reply.push("Bitcoin RPC status:");
                            reply.push("    Status: "+(btcRpcStatus==null ? "offline" : btcRpcStatus.ibd ? "verifying blockchain" : "ready"));
                            if(btcRpcStatus!=null) {
                                reply.push("    Verification progress: "+(btcRpcStatus.verificationProgress*100).toFixed(4)+"%");
                                reply.push("    Synced headers: "+btcRpcStatus.headers);
                                reply.push("    Synced blocks: "+btcRpcStatus.blocks);
                            }
                        }

                        if(this.bitcoinWallet!=null) {
                            reply.push("Bitcoin wallet status:");
                            reply.push("    Wallet status: "+this.bitcoinWallet.getStatus());
                            const bitcoinInfo = this.bitcoinWallet.getStatusInfo();
                            for(let key in bitcoinInfo) {
                                reply.push("    "+key+": "+bitcoinInfo[key]);
                            }
                        }

                        if(this.lightningWallet!=null) {
                            reply.push("Lightning wallet status:");
                            reply.push("    Wallet status: " + this.lightningWallet.getStatus());
                            if (this.lightningWallet.isReady()) reply.push("    Node pubkey: " + await this.lightningWallet.getIdentityPublicKey());
                            const lightningInfo = this.lightningWallet.getStatusInfo();
                            for (let key in lightningInfo) {
                                reply.push("    " + key + ": " + lightningInfo[key]);
                            }
                        }

                        reply.push("LP node status: "+this.initState);

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the SmartChains & Bitcoin address of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        for(let chainId in this.multichainData.chains) {
                            const {signer} = this.multichainData.chains[chainId];
                            reply.push(chainId+" address: "+signer.getAddress());
                        }

                        if(!this.bitcoinWallet.isReady()) {
                            reply.push("Bitcoin address: unknown (bitcoin wallet not ready)");
                            return reply.join("\n");
                        }

                        reply.push("Bitcoin address: "+await this.bitcoinWallet.getAddress());
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the balances of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        reply.push("Wallet balances (non-trading):");
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(signer.getAddress(), tokenAddress, false);
                                reply.push("    "+this.toReadableToken(chainId, tokenData.ticker)+": "+toDecimal(tokenBalance, tokenData.decimals));
                            }
                        }
                        reply.push("LP Vault balances (trading):");
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(signer.getAddress(),tokenAddress, true);
                                reply.push("    "+this.toReadableToken(chainId, tokenData.ticker)+": "+toDecimal(tokenBalance || new BN(0), tokenData.decimals));
                            }
                        }

                        if(this.bitcoinWallet!=null) {
                            reply.push("Bitcoin balances (trading):");
                            if(!this.bitcoinWallet.isReady()) {
                                reply.push("    BTC: unknown (bitcoin wallet not ready)");
                            } else {
                                const balances = await this.bitcoinWallet.getBalance();
                                reply.push("    BTC: "+toDecimal(new BN(balances.confirmed), 8)+" (+"+toDecimal(new BN(balances.unconfirmed), 8)+")");
                            }
                        }

                        if(this.lightningWallet!=null) {
                            if(!this.lightningWallet.isReady()) {
                                reply.push("    BTC-LN: unknown (lightning wallet not ready)");
                            } else {
                                const channelBalance = await this.lightningWallet.getLightningBalance();
                                reply.push("    BTC-LN: "+toDecimal(new BN(channelBalance.localBalance), 8)+" (+"+toDecimal(new BN(channelBalance.unsettledBalance), 8)+")");
                            }
                        }

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfer wallet balance to an external address",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: "+tokenTickers.concat(this.bitcoinWallet!=null ? ["BTC"] : []).join(", "),
                            parser: cmdEnumParser<string>(tokenTickers.concat(this.bitcoinWallet!=null ? ["BTC"] : []))
                        },
                        address: {
                            base: true,
                            description: "Destination address",
                            parser: cmdStringParser()
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate: sats/vB for BTC",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(args.asset==="BTC") {
                            if(!this.bitcoinWallet.isReady()) throw new Error("Bitcoin wallet not ready yet! Monitor the status with the 'status' command");
                            const amtBN = fromDecimal(args.amount.toFixed(8), 8);

                            const res = await this.bitcoinWallet.getSignedTransaction(args.address, amtBN.toNumber(), args.feeRate);
                            await this.bitcoinWallet.sendRawTransaction(res.raw);

                            return "Transaction sent, txId: "+res.txId;
                        }

                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {swapContract, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await swapContract.txsTransfer(signer.getAddress(), tokenData.address, amtBN, args.address);
                        await swapContract.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Transfer transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "deposit",
                "Deposits smartchain wallet balance to an LP Vault",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: "+tokenTickers.join(", "),
                            parser: cmdEnumParser<string>(tokenTickers)
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {swapContract, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];

                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await swapContract.txsDeposit(signer.getAddress(), tokenData.address, amtBN);
                        await swapContract.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Deposit transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "withdraw",
                "Withdraw LP Vault balance to node's SmartChain wallet",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: "+tokenTickers.join(", "),
                            parser: cmdEnumParser<string>(tokenTickers)
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {swapContract, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await swapContract.txsWithdraw(signer.getAddress(), tokenData.address, amtBN);
                        await swapContract.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Withdrawal transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "getreputation",
                "Checks the LP node's reputation stats",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reply: string[] = [];
                        reply.push("LP node's reputation:");
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const {ticker, decimals} = this.addressesToTokens[chainId][tokenAddress];

                                const reputation = await swapContract.getIntermediaryReputation(signer.getAddress(), tokenAddress);
                                if(reputation==null) {
                                    reply.push(this.toReadableToken(chainId, ticker)+": No reputation");
                                    continue;
                                }
                                reply.push(this.toReadableToken(chainId, ticker)+":");
                                const lnData = reputation[ChainSwapType.HTLC];
                                reply.push("   LN:");
                                reply.push("       successes: "+toDecimal(lnData.successVolume, decimals)+" ("+lnData.successCount.toString(10)+" swaps)");
                                reply.push("       fails: "+toDecimal(lnData.failVolume, decimals)+" ("+lnData.failCount.toString(10)+" swaps)");
                                reply.push("       coop closes: "+toDecimal(lnData.coopCloseVolume, decimals)+" ("+lnData.coopCloseCount.toString(10)+" swaps)");

                                const onChainData = reputation[ChainSwapType.CHAIN];
                                reply.push("   On-chain:");
                                reply.push("       successes: "+toDecimal(onChainData.successVolume, decimals)+" ("+onChainData.successCount.toString(10)+" swaps)");
                                reply.push("       fails: "+toDecimal(onChainData.failVolume, decimals)+" ("+onChainData.failCount.toString(10)+" swaps)");
                                reply.push("       coop closes: "+toDecimal(onChainData.coopCloseVolume, decimals)+" ("+onChainData.coopCloseCount.toString(10)+" swaps)");
                            }
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "plugins",
                "Shows the list of loaded plugins",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reply: string[] = [];
                        reply.push("Loaded plugins:");
                        for(let [name, plugin] of PluginManager.plugins.entries()) {
                            reply.push("    - "+name+" : "+(plugin.description || "No description"));
                        }
                        if(reply.length===1) reply.push("   No loaded plugins");
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "geturl",
                "Returns the URL of the node (only works when SSL_AUTO mode is used)",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        return "Node url: "+this.sslAutoUrl;
                    }
                }
            ),
            createCommand(
                "register",
                "Registers the URL of the node to the public LP node registry (only works when SSL_AUTO mode is used)",
                {
                    args: {
                        mail: {
                            base: true,
                            description: "E-mail to use for the LP registration, if there is something wrong with your node we will contact you here (can be empty - \"\" to opt-out)!",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        const isRegistering = await this.lpRegistry.isRegistering();
                        if(isRegistering) {
                            const {status, url} = await this.lpRegistry.getRegistrationStatus();
                            return "LP registration status: "+status+"\nGithub PR: "+url;
                        } else {
                            const url = await this.lpRegistry.register(IntermediaryConfig.BITCOIND.NETWORK==="testnet", this.sslAutoUrl, args.mail==="" ? null : args.mail);
                            return "LP registration request created: "+url;
                        }
                    }
                }
            ),
            createCommand(
                "listswaps",
                "Lists all swaps in progress",
                {
                    args: {
                        quotes: {
                            base: false,
                            description: "Whether to also show issued quotes (not yet committed to swaps) - 0/1",
                            parser: cmdNumberParser(false, 0, 1, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const swapData: string[] = [];
                        for(let swapHandler of this.swapHandlers) {
                            for(let {obj: _swap} of await swapHandler.storageManager.query([])) {
                                const tokenData = this.addressesToTokens[_swap.chainIdentifier][_swap.data.getToken().toString()];
                                if(_swap.type===SwapHandlerType.TO_BTC) {
                                    const swap = _swap as ToBtcSwapAbs;
                                    if(args.quotes!==1 && swap.state===ToBtcSwapState.SAVED) continue;
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(swap.amount, 8)+" BTC",
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+ToBtcSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC",
                                        "Network fee: "+toDecimal(swap.quotedNetworkFee, 8)+" BTC",
                                        "Address: "+swap.address
                                    ];
                                    if(swap.txId!=null) {
                                        lines.push("Tx ID: "+swap.txId);
                                        lines.push("Paid network fee: "+toDecimal(swap.realNetworkFee, 8)+" BTC");
                                    }
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.TO_BTCLN) {
                                    const swap = _swap as ToBtcLnSwapAbs;
                                    if(args.quotes!==1 && swap.state===ToBtcLnSwapState.SAVED) continue;
                                    const parsedPR = bolt11.decode(swap.pr);
                                    const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(sats, 8)+" BTC-LN",
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+ToBtcLnSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC-LN",
                                        "Network fee: "+toDecimal(swap.quotedNetworkFee, 8)+" BTC-LN",
                                        "Invoice: "+swap.pr,
                                    ];
                                    if(swap.realNetworkFee!=null) {
                                        lines.push("Paid network fee: "+toDecimal(swap.realNetworkFee, 8)+" BTC-LN");
                                    }
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTC) {
                                    const swap = _swap as FromBtcSwapAbs;
                                    if(args.quotes!==1 && swap.state===FromBtcSwapState.CREATED) continue;
                                    const lines = [
                                        toDecimal(swap.amount, 8)+" BTC -> "+toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker,
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+FromBtcSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC",
                                        "Receiving address: "+swap.address
                                    ];
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTCLN) {
                                    const swap = _swap as FromBtcLnSwapAbs;
                                    if(args.quotes!==1 && swap.state===FromBtcLnSwapState.CREATED) continue;
                                    const parsedPR = bolt11.decode(swap.pr);
                                    const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));
                                    const lines = [
                                        toDecimal(sats, 8)+" BTC-LN -> "+toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker,
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+FromBtcLnSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC-LN",
                                        "Receiving invoice: "+swap.pr
                                    ];
                                    swapData.push(lines.join("\n"));
                                }
                            }
                        }
                        return swapData.join("\n\n");
                    }
                }
            )
        ];

        if(this.bitcoinWallet!=null) {
            this.bitcoinWallet.getCommands().forEach(cmd => commands.push(cmd));
        }

        if(this.lightningWallet!=null) {
            this.lightningWallet.getCommands().forEach(cmd => commands.push(cmd));
            commands.push(
                createCommand(
                    "transferlightning",
                    "Transfer lightning wallet balance, pay lightning network invoice",
                    {
                        args: {
                            invoice: {
                                base: true,
                                description: "Lightning network invoice to pay (must specify an amount!)",
                                parser: cmdStringParser()
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(!this.lightningWallet.isReady()) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            sendLine("Sending lightning tx, waiting for confirmation...");
                            await this.lightningWallet.pay({
                                request: args.invoice,
                            });
                            const parsedInvoice = await this.lightningWallet.parsePaymentRequest(args.invoice);
                            const resp = await this.lightningWallet.waitForPayment(parsedInvoice.id);
                            if(resp.status==="confirmed") {
                                return "Lightning transaction confirmed! Preimage: "+resp.secret;
                            }
                            if(resp.status==="failed") {
                                return "Lightning failed! No bitcoin was send";
                            }
                            return "Lightning transaction is taking longer than expected, will be handled in the background!";
                        }
                    }
                )
            );
            commands.push(
                createCommand(
                    "receivelightning",
                    "Creates a lightning network invoice",
                    {
                        args: {
                            amount: {
                                base: true,
                                description: "Amount of BTC to receive over lightning",
                                parser: cmdNumberParser(true, 0, null, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(!this.lightningWallet.isReady()) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                            const resp = await this.lightningWallet.createInvoice({
                                mtokens: amtBN==null ? undefined : amtBN.mul(new BN(1000))
                            });
                            return "Lightning network invoice: "+resp.request;
                        }
                    }
                )
            );
        }

        this.cmdHandler = new CommandHandler(commands, IntermediaryConfig.CLI.ADDRESS, IntermediaryConfig.CLI.PORT, "Welcome to atomiq intermediary (LP node) CLI!");
    }

    async init() {
        await this.cmdHandler.init();
        await super.init();
        for(let plugin of PluginManager.plugins.values()) {
            if(plugin.getCommands!=null) {
                plugin.getCommands().forEach(cmd => this.cmdHandler.registerCommand(cmd));
            }
        }
    }

}